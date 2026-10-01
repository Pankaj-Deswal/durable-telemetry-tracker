import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Outbox } from "../src/outbox.ts";
import {
  startTracker,
  validateConfig,
  type Message,
  type TrackerConfig,
} from "../src/tracker.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track1k-"));
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

describe("tracking concurrency / scale", () => {
  it("slow outbox write: overlapping ticks do not duplicate or corrupt state", async () => {
    jest.useFakeTimers();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const outbox = new Outbox(tempDb());
    const realAppend = outbox.append.bind(outbox);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inFlight = 0;
    let maxInFlight = 0;

    jest.spyOn(outbox, "append").mockImplementation(async (message) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      try {
        await realAppend(message);
      } finally {
        inFlight--;
      }
    });

    const stop = startTracker(
      { name: "one", source: "sin", sampleMs: 1000, precision: 5 },
      outbox,
    );

    // first tick is waiting on the slow append
    await Promise.resolve();
    expect(inFlight).toBe(1);

    // interval fires while append is still in flight
    now += 1000;
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    release();
    await Promise.resolve();
    await Promise.resolve();

    const messages = await outbox.all();
    expect(maxInFlight).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].name).toBe("one");

    stop();
    await outbox.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("1000 trackers from config1000.json each keep their first sample", async () => {
    const configPath = path.join(root, "config1000.json");
    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as TrackerConfig[];

    expect(config).toHaveLength(1000);
    expect(() => validateConfig(config)).not.toThrow();

    const outbox = new Outbox(tempDb());
    const stops = config.map((c) => startTracker(c, outbox));
    await sleep(100);
    for (const stop of stops) stop();

    const messages = await outbox.all();
    expect(messages).toHaveLength(1000);
    expect(new Set(messages.map((m) => m.name)).size).toBe(1000);
    await outbox.close();
  });

  it(
    "1000 trackers stay open 10s with slow writes; DB matches in-memory kept list",
    async () => {
      const configPath = path.join(root, "config1000.json");
      const config = (
        JSON.parse(fs.readFileSync(configPath, "utf8")) as TrackerConfig[]
      ).map((c) => ({ ...c, precision: 0 }));

      expect(config).toHaveLength(1000);
      validateConfig(config);

      const outbox = new Outbox(tempDb());
      const kept: Message[] = [];
      const realAppend = outbox.append.bind(outbox);

      jest.spyOn(outbox, "append").mockImplementation(async (message) => {
        await sleep(15);
        await realAppend(message);
      });

      const stops = config.map((c) => startTracker(c, outbox, kept));
      await sleep(10_000);
      for (const stop of stops) stop();
      await sleep(200); // drain in-flight appends

      const dbMessages = await outbox.all();
      const byKey = (m: Message) => `${m.name}:${m.ts}:${m.value}`;
      expect(dbMessages.map(byKey).sort()).toEqual(kept.map(byKey).sort());
      expect(new Set(dbMessages.map((m) => m.name)).size).toBe(1000);
      expect(dbMessages.length).toBe(kept.length);
      expect(dbMessages.length).toBeGreaterThanOrEqual(10_000);

      await outbox.close();
      jest.restoreAllMocks();
    },
    60_000,
  );
});
