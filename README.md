# Durable telemetry tracker

Node.js 24 + TypeScript app with two stages:

1. **Tracking** — sample virtual `sin`/`cos` sources, keep interesting values, store them in a local SQLite outbox.
2. **Forwarding** — every 10s publish unpublished messages in batches of at most 5,000 over an unreliable stdout channel.

## Run

```bash
npm install
npm start
```

Reads `config.json`, writes kept messages to `data/outbox.sqlite`, publishes batches as JSON lines on **stdout**, logs to **stderr**. Stop with Ctrl+C.

```bash
npm test
```

Jest suites: `tests/tracking.test.ts` (config → outbox) and `tests/forwarding.test.ts` (outbox → publish), covering happy and sad paths.

## Design

### Tracking

Each tracker samples its source every `sampleMs` and keeps a sample when:

- it is the first sample of this process, or
- `|value - lastKept| >= precision`, or
- more than 15 seconds have passed since the last **kept** sample (heartbeat).

Kept samples `{ name, ts, value }` are appended with `INSERT OR IGNORE` on `(name, ts)`. Last-kept state lives only in memory: after a restart the next sample is always kept.

### Forwarding

The outbox stores `batch_id` and `published` per message:

- **pending** — not yet assigned a batch
- **in flight** — has a `batch_id`, not yet published
- **published** — `publish` resolved successfully

Every 10s the forwarder claims one batch (reuse any in-flight `batch_id`, else assign a new UUID to up to 5,000 pending rows), then calls `publish`. Failures (reject, hang past 5s timeout, write-then-reject) leave the batch in flight so the next attempt uses the **same** `batch_id`. Only a successful resolve marks it published.

`publish` writes one JSON line to stdout and fails often enough that retries matter. The receiver deduplicates on `batch_id`.

## Guarantees

- A sample that `append` committed is still there after a process restart.
- Every committed outbox message eventually appears on stdout if the process keeps running.
- After deduplicating by `batch_id`, each message appears in exactly one batch.
- A crash mid-write does not leave a corrupt database; an uncommitted `append` may be lost. An in-flight batch is retried with the same id after restart.

## Left out

Config validation, metrics, deleting published rows, multiple concurrent in-flight batches.
