import { describe, expect, it } from "vitest";
import { HEARTBEAT_MS, shouldKeep, type KeptSample } from "../src/tracker.ts";
import { cos, sin } from "../src/sources.ts";

describe("shouldKeep", () => {
  it("keeps the first sample", () => {
    expect(shouldKeep(18, 1000, null, 5)).toBe(true);
  });

  it("drops a change smaller than precision", () => {
    const last: KeptSample = { ts: 0, value: 18 };
    expect(shouldKeep(19, 1000, last, 5)).toBe(false);
  });

  it("keeps a change of at least precision", () => {
    const last: KeptSample = { ts: 0, value: 18 };
    expect(shouldKeep(23, 1000, last, 5)).toBe(true); // |delta| == precision
    expect(shouldKeep(13, 1000, last, 5)).toBe(true);
  });

  it("keeps a heartbeat only after more than 15s", () => {
    const last: KeptSample = { ts: 0, value: 18 };
    expect(shouldKeep(19, HEARTBEAT_MS, last, 5)).toBe(false);
    expect(shouldKeep(19, HEARTBEAT_MS + 1, last, 5)).toBe(true);
  });

  it("keeps a significant change even before the heartbeat window", () => {
    const last: KeptSample = { ts: 0, value: 18 };
    expect(shouldKeep(23, 1000, last, 5)).toBe(true);
  });
});

describe("sources", () => {
  it("are deterministic for a fixed time", () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
    expect(sin(12345)).toBe(sin(12345));
    expect(cos(12345)).toBe(cos(12345));
  });
});
