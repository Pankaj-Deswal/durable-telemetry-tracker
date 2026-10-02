import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import Database from "better-sqlite3";
import { Outbox } from "../src/outbox.ts";
import { startTracker, validateConfig, type TrackerConfig } from "../src/tracker.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-"));
  dirs.push(dir);
  return path.join(dir, "outbox.sqlite");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("tracking (config → outbox)", () => {
  it("happy: first samples from config land in the outbox", async () => {
    const config: TrackerConfig[] = [
      { name: "one", source: "sin", sampleMs: 1000, precision: 0.08 },
      { name: "two", source: "cos", sampleMs: 2000, precision: 0.15 },
      { name: "three", source: "sin", sampleMs: 1000, precision: 5 },
    ];
    const outbox = new Outbox(tempDb());
    const stops = config.map((c) => startTracker(c, outbox));

    await sleep(50);
    for (const stop of stops) stop();

    const messages = await outbox.all();
    expect(messages.map((m) => m.name).sort()).toEqual(["one", "three", "two"]);
    for (const m of messages) {
      expect(m.ts).toBeGreaterThan(0);
      expect(typeof m.value).toBe("number");
    }
    await outbox.close();
  });

  it("happy: significant change is stored", async () => {
    const outbox = new Outbox(tempDb());
    const stop = startTracker(
      { name: "one", source: "sin", sampleMs: 1000, precision: 0.01 },
      outbox,
    );
    await sleep(1100);
    stop();

    expect((await outbox.all()).length).toBeGreaterThan(1);
    await outbox.close();
  });

  it("happy: heartbeat keeps after 15s without a significant change", async () => {
    jest.useFakeTimers();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const outbox = new Outbox(tempDb());
    const stop = startTracker(
      { name: "three", source: "sin", sampleMs: 1000, precision: 5 },
      outbox,
    );
    await Promise.resolve();
    expect(await outbox.all()).toHaveLength(1);

    now += 1000;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outbox.all()).toHaveLength(1);

    now += 14_001;
    await jest.advanceTimersByTimeAsync(1000);
    const messages = await outbox.all();
    expect(messages).toHaveLength(2);
    expect(messages[1].ts - messages[0].ts).toBeGreaterThan(15_000);

    stop();
    await outbox.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("happy: after restart, each tracker's first sample is kept again", async () => {
    jest.useFakeTimers();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const config: TrackerConfig = {
      name: "three",
      source: "sin",
      sampleMs: 1000,
      precision: 5,
    };
    const outbox = new Outbox(tempDb());

    const stop1 = startTracker(config, outbox);
    await Promise.resolve();
    expect(await outbox.all()).toHaveLength(1);

    now += 1000;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outbox.all()).toHaveLength(1);
    stop1();

    now += 1000;
    const stop2 = startTracker(config, outbox);
    await Promise.resolve();
    const messages = await outbox.all();
    expect(messages).toHaveLength(2);
    expect(messages[1].ts).toBe(now);

    stop2();
    await outbox.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sad: failed append does not update lastKept; later ticks continue", async () => {
    jest.useFakeTimers();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const outbox = new Outbox(tempDb());
    jest.spyOn(outbox, "append").mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const stop = startTracker(
      { name: "three", source: "sin", sampleMs: 1000, precision: 5 },
      outbox,
    );
    await Promise.resolve();
    expect(await outbox.all()).toHaveLength(0);

    now += 1000;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outbox.all()).toHaveLength(1);

    stop();
    await outbox.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sad: tiny change with high precision is not stored", async () => {
    const outbox = new Outbox(tempDb());
    const stop = startTracker(
      { name: "three", source: "sin", sampleMs: 1000, precision: 5 },
      outbox,
    );
    await sleep(1100);
    stop();

    const messages = await outbox.all();
    expect(messages).toHaveLength(1);
    expect(messages[0].name).toBe("three");
    await outbox.close();
  });

  it("sad: duplicate name+ts is not stored twice", async () => {
    const outbox = new Outbox(tempDb());
    await outbox.append({ name: "one", ts: 1000, value: 0.1 });
    await outbox.append({ name: "one", ts: 1000, value: 0.9 });
    expect(await outbox.all()).toEqual([{ name: "one", ts: 1000, value: 0.1 }]);
    await outbox.close();
  });

  it("sad: crash mid-write may lose the latest row; outbox stays usable", async () => {
    const dbPath = tempDb();
    const before = new Outbox(dbPath);
    await before.append({ name: "one", ts: 1, value: 0.1 });
    await before.close();

    // Simulate dying during an uncommitted insert after a successful write.
    const raw = new Database(dbPath);
    raw.exec("BEGIN IMMEDIATE");
    raw
      .prepare("INSERT INTO messages (name, ts, value) VALUES (?, ?, ?)")
      .run("lost", 2, 0.2);
    raw.close();

    const after = new Outbox(dbPath);
    expect(await after.all()).toEqual([{ name: "one", ts: 1, value: 0.1 }]);
    await after.append({ name: "three", ts: 3, value: 0.3 });
    expect(await after.all()).toEqual([
      { name: "one", ts: 1, value: 0.1 },
      { name: "three", ts: 3, value: 0.3 },
    ]);
    await after.close();
  });

  it("sad: invalid config entries are rejected", () => {
    expect(() =>
      validateConfig([
        { name: "one", source: "sin", sampleMs: 1000, precision: 0.08 },
        { name: "one", source: "cos", sampleMs: 1000, precision: 0.15 },
      ]),
    ).toThrow(
      "Duplicate name+sampleMs value Not supportted. Correct the JSON file.",
    );

    expect(() =>
      validateConfig([{ name: "", source: "sin", sampleMs: 1000, precision: 0.1 }]),
    ).toThrow("Empty name is not supported. Correct the JSON file.");

    expect(() =>
      validateConfig([
        { name: "one", source: "tan", sampleMs: 1000, precision: 0.1 },
      ]),
    ).toThrow('Unknown source "tan". Correct the JSON file.');

    expect(() =>
      validateConfig([
        { name: "one", source: "sin", sampleMs: 999, precision: 0.1 },
      ]),
    ).toThrow("sampleMs must be >= 1000. Correct the JSON file.");

    expect(() =>
      validateConfig([
        { name: "one", source: "sin", sampleMs: 1000, precision: -1 },
      ]),
    ).toThrow("Invalid precision. Correct the JSON file.");

    expect(() =>
      validateConfig([
        { name: "one", source: "sin", sampleMs: 1000, precision: Number.NaN },
      ]),
    ).toThrow("Invalid precision. Correct the JSON file.");
  });
});
