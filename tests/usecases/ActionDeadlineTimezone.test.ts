import { describe, expect, it, vi } from "vitest";
import { CreateActionFromExplicit } from "../../src/application/usecases/actions/CreateActionFromExplicit";
import { UpdateActionDeadline } from "../../src/application/usecases/actions/UpdateActionDeadline";

const conversationId = { id: "conv", domain: "wire.com" };
const actor = { id: "alice", domain: "wire.com" };
const due = new Date("2026-10-02T13:00:00Z");

describe("action deadline confirmations", () => {
  it.each([["Europe/Berlin", "2 Oct 2026, 15:00 CEST"], ["UTC", "2 Oct 2026, 13:00 UTC"]])(
    "shows a new action's deadline in the conversation timezone %s", async (timezone, shown) => {
      const repo = { nextId: vi.fn().mockResolvedValue("ACT-1"), query: vi.fn().mockResolvedValue([]), create: vi.fn(async (a) => a) };
      const wire = { sendPlainText: vi.fn() };
      const useCase = new CreateActionFromExplicit(repo as never, { get: vi.fn().mockResolvedValue({ timezone }) } as never,
        { parse: vi.fn().mockReturnValue({ value: due }) } as never, { resolveByHandleOrName: vi.fn() }, wire as never,
        { append: vi.fn() }, { info: vi.fn() } as never);
      await useCase.execute({ conversationId, creatorId: actor, authorName: "Alice", rawMessageId: "m", description: "Review", deadlineText: "Friday 3pm" });
      expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId,
        `Action **ACT-1** created for **Alice**: Review (due Friday 3pm: ${shown})`, { replyToMessageId: "m" });
    });

  it("shows an updated deadline in the conversation timezone", async () => {
    const action = { id: "ACT-1", conversationId, deleted: false, version: 1 };
    const repo = { findById: vi.fn().mockResolvedValue(action), update: vi.fn() };
    const wire = { sendPlainText: vi.fn() };
    const useCase = new UpdateActionDeadline(repo as never, { parse: vi.fn().mockReturnValue({ value: due }) } as never, wire as never, { append: vi.fn() });
    await useCase.execute({ actionId: "ACT-1", conversationId, actorId: actor, deadlineText: "Friday 3pm", timezone: "Europe/Berlin", replyToMessageId: "m" });
    expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId, "**ACT-1** deadline set to **2 Oct 2026, 15:00 CEST**.", { replyToMessageId: "m" });
  });
});
