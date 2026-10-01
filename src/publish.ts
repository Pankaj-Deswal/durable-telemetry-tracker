import { log } from "./log.ts";
import type { Batch } from "./outbox.ts";

export type RandomFn = () => number;

/** Unreliable publish: often fails by rejecting, hanging, or write-then-reject. */
export function publish(
  batch: Batch,
  random: RandomFn = Math.random,
): Promise<void> {
  const r = random();
  // ~40% success, ~20% reject, ~20% hang, ~20% write-then-reject
  if (r < 0.2) {
    log("publish rejected (no write)");
    return Promise.reject(new Error("publish failed"));
  }
  if (r < 0.4) {
    log("publish hang");
    return new Promise(() => {});
  }

  process.stdout.write(JSON.stringify(batch) + "\n");

  if (r < 0.6) {
    log("publish wrote then rejected");
    return Promise.reject(new Error("publish failed after write"));
  }
  return Promise.resolve();
}
