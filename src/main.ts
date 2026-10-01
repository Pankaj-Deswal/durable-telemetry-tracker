import fs from "node:fs";
import path from "node:path";
import { startForwarder } from "./forwarder.ts";
import { log } from "./log.ts";
import { Outbox } from "./outbox.ts";
import { startTracker, validateConfig, type TrackerConfig } from "./tracker.ts";

const root = path.resolve(import.meta.dirname, "..");
const configPath = path.join(root, "config.json");
const dbPath = path.join(root, "data", "outbox.sqlite");

const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as TrackerConfig[];
validateConfig(config);
const outbox = new Outbox(dbPath);

log("tracking", config.length, "trackers; outbox", dbPath);

const stops = config.map((tracker) => startTracker(tracker, outbox));
const stopForwarder = startForwarder(outbox);

function shutdown() {
  for (const stop of stops) stop();
  stopForwarder();
  void outbox.close();
  log("stopped");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
