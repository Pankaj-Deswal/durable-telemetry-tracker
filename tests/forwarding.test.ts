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

  it("happy: more than 5000 pending messages are capped at 5000 with one batch_id", async () => {
    const outbox = new Outbox(tempDb());
    for (let i = 0; i < 5001; i++) {
      await outbox.append({ name: `event_${i}`, ts: i, value: i });
    }

    const written: Batch[] = [];
    await runOnce(outbox, async (batch) => {
      written.push(batch);
    });

    expect(written).toHaveLength(1);
    expect(written[0].messages).toHaveLength(5000);
    expect(new Set(written[0].messages.map((m) => m.ts)).size).toBe(5000);
    // every claimed message belongs to this single batch_id
    expect(written[0].batch_id).toBeTruthy();

    const rest = await outbox.claimBatch();
    expect(rest).not.toBeNull();
    expect(rest!.messages).toHaveLength(1);
    expect(rest!.messages[0].ts).toBe(5000);
    expect(rest!.batch_id).not.toBe(written[0].batch_id);
    await outbox.close();
  });

  it("happy: after failure, retry sends only the failed batch before new events", async () => {
    const outbox = new Outbox(tempDb());
    await outbox.append({ name: "event_1", ts: 1, value: 0.1 });
    await outbox.append({ name: "event_2", ts: 2, value: 0.2 });

    let failedId = "";
    await runOnce(outbox, async (batch) => {
      failedId = batch.batch_id;
      throw new Error("fail");
    });

    // new events arrive while the previous batch is still in flight
    await outbox.append({ name: "event_3", ts: 3, value: 0.3 });
    await outbox.append({ name: "event_4", ts: 4, value: 0.4 });

    const retried: Batch[] = [];
    await runOnce(outbox, async (batch) => {
      retried.push(batch);
    });

    expect(retried).toHaveLength(1);
    expect(retried[0].batch_id).toBe(failedId);
    expect(retried[0].messages).toEqual([
      { name: "event_1", ts: 1, value: 0.1 },
      { name: "event_2", ts: 2, value: 0.2 },
    ]);

    const next: Batch[] = [];
    await runOnce(outbox, async (batch) => {
      next.push(batch);
    });

    expect(next).toHaveLength(1);
    expect(next[0].batch_id).not.toBe(failedId);
    expect(next[0].messages).toEqual([
      { name: "event_3", ts: 3, value: 0.3 },
      { name: "event_4", ts: 4, value: 0.4 },
    ]);
    expect(await outbox.claimBatch()).toBeNull();
    await outbox.close();
  });
});
