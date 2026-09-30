import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOnce } from "../src/forwarder.ts";
import { Outbox } from "../src/outbox.ts";
import type { Batch } from "../src/outbox.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwd-"));
  dirs.push(dir);
  return path.join(dir, "outbox.sqlite");
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("runOnce", () => {
  it("does not call publish when empty", async () => {
    const outbox = new Outbox(tempDb());
    let called = 0;
    await runOnce(outbox, async () => {
      called++;
    });
    expect(called).toBe(0);
    outbox.close();
  });

  it("marks published on success", async () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 1, value: 0.1 });
    const seen: Batch[] = [];
    await runOnce(outbox, async (batch) => {
      seen.push(batch);
    });
    expect(seen).toHaveLength(1);
    expect(outbox.claimBatch()).toBeNull();
    outbox.close();
  });

  it("retries same batch_id after reject", async () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 1, value: 0.1 });
    const ids: string[] = [];

    await runOnce(outbox, async (batch) => {
      ids.push(batch.batch_id);
      throw new Error("fail");
    });
    await runOnce(outbox, async (batch) => {
      ids.push(batch.batch_id);
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(outbox.claimBatch()).toBeNull();
    outbox.close();
  });

  it("retries same batch_id after timeout", async () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 1, value: 0.1 });
    const ids: string[] = [];

    await runOnce(
      outbox,
      (batch) => {
        ids.push(batch.batch_id);
        return new Promise(() => {});
      },
      20,
    );
    await runOnce(outbox, async (batch) => {
      ids.push(batch.batch_id);
    });

    expect(ids).toEqual([ids[0], ids[0]]);
    expect(outbox.claimBatch()).toBeNull();
    outbox.close();
  });

  it("after success, a new message gets a different batch_id", async () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 1, value: 0.1 });
    let firstId = "";
    await runOnce(outbox, async (batch) => {
      firstId = batch.batch_id;
    });

    outbox.append({ name: "one", ts: 2, value: 0.2 });
    let secondId = "";
    await runOnce(outbox, async (batch) => {
      secondId = batch.batch_id;
    });

    expect(secondId).not.toBe(firstId);
    outbox.close();
  });
});
