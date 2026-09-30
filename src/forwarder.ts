import { log } from "./log.ts";
import type { Batch, Outbox } from "./outbox.ts";
import { publish as defaultPublish } from "./publish.ts";

export const FORWARD_INTERVAL_MS = 10_000;
export const PUBLISH_TIMEOUT_MS = 5_000;

export type PublishFn = (batch: Batch) => Promise<void>;

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("publish timeout")), ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

export async function runOnce(
  outbox: Outbox,
  publishFn: PublishFn = defaultPublish,
  timeoutMs = PUBLISH_TIMEOUT_MS,
): Promise<void> {
  const batch = outbox.claimBatch();
  if (!batch) return;

  try {
    await withTimeout(publishFn(batch), timeoutMs);
    outbox.markPublished(batch.batch_id);
    log("published", batch.batch_id, batch.messages.length);
  } catch (err) {
    log("publish failed", batch.batch_id, String(err));
  }
}

export function startForwarder(
  outbox: Outbox,
  publishFn: PublishFn = defaultPublish,
  intervalMs = FORWARD_INTERVAL_MS,
  timeoutMs = PUBLISH_TIMEOUT_MS,
): () => void {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce(outbox, publishFn, timeoutMs);
    } finally {
      busy = false;
    }
  };

  void tick();
  const id = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(id);
}
