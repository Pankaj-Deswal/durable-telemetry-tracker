import { log } from "./log.ts";
import type { Outbox } from "./outbox.ts";
import { sources } from "./sources.ts";

export const HEARTBEAT_MS = 15_000;

export type KeptSample = {
  ts: number;
  value: number;
};

export type Message = {
  name: string;
  ts: number;
  value: number;
};

export type TrackerConfig = {
  name: string;
  source: "sin" | "cos";
  sampleMs: number;
  precision: number;
};

export function validateConfig(config: TrackerConfig[]): void {
  const seen = new Set<string>();
  for (const tracker of config) {
    const key = `${tracker.name}:${tracker.sampleMs}`;
    if (seen.has(key)) {
      throw new Error(
        "Duplicate name+sampleMs value Not supportted. Correct the JSON file.",
      );
    }
    seen.add(key);
  }
}

export function shouldKeep(
  value: number,
  ts: number,
  lastKept: KeptSample | null,
  precision: number,
): boolean {
  if (lastKept === null) return true;  
  if (Math.abs(value - lastKept.value) >= precision) return true;
  if (ts - lastKept.ts > HEARTBEAT_MS) return true;
  return false;
}

export function startTracker(
  config: TrackerConfig,
  outbox: Outbox,
  kept?: Message[],
): () => void {
  const sample = sources[config.source];
  let lastKept: KeptSample | null = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    const ts = Date.now();
    const value = sample(ts);
    if (!shouldKeep(value, ts, lastKept, config.precision)) return;
    busy = true;
    const message: Message = { name: config.name, ts, value };
    try {
      kept?.push(message);
      await outbox.append(message);
      lastKept = { ts, value };
      log("kept", config.name, ts, value);
    } catch (err) {
      // leave lastKept unchanged; drop this sample and continue
      log("append failed", config.name, ts, String(err));
    } finally {
      busy = false;
    }
  };

  void tick();
  const id = setInterval(() => void tick(), config.sampleMs);
  return () => clearInterval(id);
}
