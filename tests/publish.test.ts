import { afterEach, describe, expect, it, vi } from "vitest";
import { publish } from "../src/publish.ts";

const batch = {
  batch_id: "b1",
  messages: [{ name: "one", ts: 1, value: 0.4 }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publish", () => {
  it("rejects without writing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(publish(batch, () => 0.1)).rejects.toThrow("publish failed");
    expect(write).not.toHaveBeenCalled();
  });

  it("hangs without resolving", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const p = publish(batch, () => 0.3);
    const raced = await Promise.race([
      p.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(raced).toBe("pending");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes then rejects", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(publish(batch, () => 0.5)).rejects.toThrow(
      "publish failed after write",
    );
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toBe(JSON.stringify(batch) + "\n");
  });

  it("writes then resolves", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await publish(batch, () => 0.7);
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(String(write.mock.calls[0][0]).trim())).toEqual(batch);
  });
});
