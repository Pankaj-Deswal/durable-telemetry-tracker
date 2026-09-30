import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Outbox } from "../src/outbox.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-"));
  dirs.push(dir);
  return path.join(dir, "outbox.sqlite");
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("Outbox", () => {
  it("appends and reads messages", () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 10, value: 0.4 });
    outbox.append({ name: "two", ts: 20, value: -0.1 });
    expect(outbox.all()).toEqual([
      { name: "one", ts: 10, value: 0.4 },
      { name: "two", ts: 20, value: -0.1 },
    ]);
    outbox.close();
  });

  it("ignores duplicate name+ts", () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 10, value: 0.4 });
    outbox.append({ name: "one", ts: 10, value: 0.9 });
    expect(outbox.all()).toEqual([{ name: "one", ts: 10, value: 0.4 }]);
    outbox.close();
  });

  it("survives reopen", () => {
    const dbPath = tempDb();
    const first = new Outbox(dbPath);
    first.append({ name: "one", ts: 10, value: 0.4 });
    first.close();

    const second = new Outbox(dbPath);
    expect(second.all()).toEqual([{ name: "one", ts: 10, value: 0.4 }]);
    second.close();
  });

  it("claimBatch returns null when empty", () => {
    const outbox = new Outbox(tempDb());
    expect(outbox.claimBatch()).toBeNull();
    outbox.close();
  });

  it("claimBatch assigns a batch_id and caps at limit", () => {
    const outbox = new Outbox(tempDb());
    for (let i = 0; i < 7; i++) {
      outbox.append({ name: "one", ts: i, value: i });
    }
    const batch = outbox.claimBatch(5);
    expect(batch).not.toBeNull();
    expect(batch!.messages).toHaveLength(5);
    expect(batch!.batch_id).toBeTruthy();
    expect(batch!.messages.map((m) => m.ts)).toEqual([0, 1, 2, 3, 4]);
    outbox.close();
  });

  it("reuses in-flight batch_id and ignores later appends", () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 1, value: 0.1 });
    outbox.append({ name: "one", ts: 2, value: 0.2 });
    const first = outbox.claimBatch()!;
    outbox.append({ name: "one", ts: 3, value: 0.3 });

    const second = outbox.claimBatch()!;
    expect(second.batch_id).toBe(first.batch_id);
    expect(second.messages).toEqual(first.messages);
    outbox.close();
  });

  it("survives reopen with same in-flight batch_id", () => {
    const dbPath = tempDb();
    const first = new Outbox(dbPath);
    first.append({ name: "one", ts: 10, value: 0.4 });
    const claimed = first.claimBatch()!;
    first.close();

    const second = new Outbox(dbPath);
    const again = second.claimBatch()!;
    expect(again.batch_id).toBe(claimed.batch_id);
    expect(again.messages).toEqual(claimed.messages);
    second.close();
  });

  it("after markPublished, next claim gets remaining pendings with a new id", () => {
    const outbox = new Outbox(tempDb());
    outbox.append({ name: "one", ts: 1, value: 0.1 });
    outbox.append({ name: "one", ts: 2, value: 0.2 });
    const first = outbox.claimBatch(1)!;
    outbox.markPublished(first.batch_id);

    const second = outbox.claimBatch()!;
    expect(second.batch_id).not.toBe(first.batch_id);
    expect(second.messages).toEqual([{ name: "one", ts: 2, value: 0.2 }]);
    outbox.close();
  });
});
