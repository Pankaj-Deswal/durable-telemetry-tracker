import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { runOnce } from "../src/forwarder.ts";
import { Outbox, type Batch } from "../src/outbox.ts";
import { publish } from "../src/publish.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwd-"));
  dirs.push(dir);
  return path.join(dir, "outbox.sqlite");
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("forwarding (outbox → publish)", () => {
  it("happy: claims a batch, publishes it, and marks it done", async () => {
    const outbox = new Outbox(tempDb());
    await outbox.append({ name: "one", ts: 1, value: 0.1 });
    await outbox.append({ name: "two", ts: 2, value: 0.2 });

    const written: Batch[] = [];
    await runOnce(outbox, async (batch) => {
      written.push(batch);
    });

    expect(written).toHaveLength(1);
    expect(written[0].messages).toHaveLength(2);
    expect(written[0].batch_id).toBeTruthy();
    expect(await outbox.claimBatch()).toBeNull();
    await outbox.close();
  });

  it("happy: publish writes one JSON line to stdout on success", async () => {
    const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    const batch: Batch = {
      batch_id: "b1",
      messages: [{ name: "one", ts: 1, value: 0.4 }],
    };
    await publish(batch, () => 0.7);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0][0]).trim())).toEqual(batch);
  });

  it("sad: empty outbox does not publish", async () => {
    const outbox = new Outbox(tempDb());
    let called = 0;
    await runOnce(outbox, async () => {
      called++;
    });
    expect(called).toBe(0);
    await outbox.close();
  });

  it("sad: failed publish keeps the same batch_id for retry", async () => {
    const outbox = new Outbox(tempDb());
    await outbox.append({ name: "one", ts: 1, value: 0.1 });
    const ids: string[] = [];

    await runOnce(outbox, async (batch) => {
      ids.push(batch.batch_id);
      throw new Error("fail");
    });
    await runOnce(outbox, async (batch) => {
      ids.push(batch.batch_id);
    });

    expect(ids).toEqual([ids[0], ids[0]]);
    expect(await outbox.claimBatch()).toBeNull();
    await outbox.close();
  });

  it("sad: timeout keeps the same batch_id for retry", async () => {
    const outbox = new Outbox(tempDb());
    await outbox.append({ name: "one", ts: 1, value: 0.1 });
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
    await outbox.close();
  });

  it("sad: publish reject / write-then-reject does not mark published", async () => {
    const outbox = new Outbox(tempDb());
    await outbox.append({ name: "one", ts: 1, value: 0.1 });
    const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);

    await runOnce(outbox, (batch) => publish(batch, () => 0.1));
    expect(write).not.toHaveBeenCalled();
    expect((await outbox.claimBatch())?.messages).toHaveLength(1);

    await runOnce(outbox, (batch) => publish(batch, () => 0.5));
    expect(write).toHaveBeenCalled();
    const still = await outbox.claimBatch();
    expect(still).not.toBeNull();
    expect(still!.messages).toHaveLength(1);
    await outbox.close();
  });
});
