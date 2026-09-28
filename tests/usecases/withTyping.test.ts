import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTyping } from "../../src/application/services/typing";

const conv = { id: "conv-1", domain: "wire.com" };
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() });
const outbound = (setTyping = vi.fn().mockResolvedValue(undefined)) => ({ setTyping }) as never as { setTyping: ReturnType<typeof vi.fn> };

describe("withTyping", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows typing at once, refreshes it while the work runs and clears it afterwards", async () => {
    const out = outbound();
    let finish: (v: string) => void = () => {};
    const run = withTyping(out as never, conv, () => new Promise<string>((r) => { finish = r; }), logger(), 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(out.setTyping.mock.calls).toEqual([[conv, true]]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(out.setTyping.mock.calls).toEqual([[conv, true], [conv, true], [conv, true]]);
    finish("answer");
    await expect(run).resolves.toBe("answer");
    await vi.advanceTimersByTimeAsync(3000);
    expect(out.setTyping.mock.calls.at(-1)).toEqual([conv, false]);
    expect(out.setTyping).toHaveBeenCalledTimes(4);
  });

  it("clears typing when the work fails and passes the failure on", async () => {
    const out = outbound();
    await expect(withTyping(out as never, conv, async () => { throw new TypeError("boom"); }, logger())).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(0);
    expect(out.setTyping.mock.calls.at(-1)).toEqual([conv, false]);
  });

  it("never delays the work: it starts before the typing call has answered", async () => {
    const out = outbound(vi.fn(() => new Promise<void>(() => {})));
    const work = vi.fn().mockResolvedValue("done");
    await expect(withTyping(out as never, conv, work, logger())).resolves.toBe("done");
    expect(work).toHaveBeenCalled();
  });

  it("sends stopped only after started has gone out", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const out = outbound(vi.fn((_c, typing: boolean) => {
      if (typing) return new Promise<void>((r) => { release = () => { order.push("started"); r(); }; });
      order.push("stopped");
      return Promise.resolve();
    }));
    await withTyping(out as never, conv, async () => "quick", logger());
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["started", "stopped"]);
  });

  it("logs a failing indicator once by error name and still returns the answer, even for a synchronous throw", async () => {
    const log = logger();
    const out = outbound(vi.fn(() => { throw new RangeError("secret detail"); }));
    const run = withTyping(out as never, conv, async () => { await new Promise((r) => setTimeout(r, 2500)); return "answer"; }, log, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(run).resolves.toBe("answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("Typing indicator failed", { err: "RangeError" });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret detail");
  });
});
