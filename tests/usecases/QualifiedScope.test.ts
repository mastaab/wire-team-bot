import { describe, it, expect, vi } from "vitest";
import { ReassignAction } from "../../src/application/usecases/actions/ReassignAction";
import { UpdateActionDeadline } from "../../src/application/usecases/actions/UpdateActionDeadline";
import { UpdateActionStatus } from "../../src/application/usecases/actions/UpdateActionStatus";
import { RevokeDecision } from "../../src/application/usecases/decisions/RevokeDecision";
import { SupersedeDecision } from "../../src/application/usecases/decisions/SupersedeDecision";
import { CancelReminder } from "../../src/application/usecases/reminders/CancelReminder";
import { SnoozeReminder } from "../../src/application/usecases/reminders/SnoozeReminder";

describe("mutation scope", () => {
  it.each([{ id: "foreign", domain: "wire.com" }, { id: "conv", domain: "foreign.com" }])("denies %j without writes or scheduling", async conversationId => {
    const repo = { findById: vi.fn().mockResolvedValue({ conversationId }), create: vi.fn(), update: vi.fn(), nextId: vi.fn() };
    const wire = { sendPlainText: vi.fn() };
    const audit = { append: vi.fn() };
    const resolver = { resolveByHandleOrName: vi.fn() };
    const dates = { parse: vi.fn() };
    const scheduler = { cancel: vi.fn(), schedule: vi.fn() };
    const cases = [
      new ReassignAction(repo as never, resolver, wire as never, audit),
      new UpdateActionDeadline(repo as never, dates as never, wire as never, audit),
      new UpdateActionStatus(repo as never, wire as never, audit),
      new RevokeDecision(repo as never, wire as never, audit),
      new SupersedeDecision(repo as never, wire as never, audit),
      new CancelReminder(repo as never, scheduler as never, wire as never, audit),
      new SnoozeReminder(repo as never, dates as never, scheduler as never, wire as never, audit),
    ];
    const input = { conversationId: { id: "conv", domain: "wire.com" }, actionId: "ACT-0001", decisionId: "DEC-0001", supersedesDecisionId: "DEC-0001", reminderId: "REM-0001" };
    for (const useCase of cases) {
      expect(await useCase.execute(input as never)).toBeNull();
    }
    // The reply is the same for any reason (unknown, deleted, another conversation's), so it reveals nothing.
    const replies = wire.sendPlainText.mock.calls.map((call) => call[1] as string);
    expect(replies.slice(0, 3)).toEqual(Array(3).fill("I'm afraid **ACT-0001** isn't an action in this conversation."));
    expect(replies.slice(3, 5)).toEqual(Array(2).fill("I'm afraid **DEC-0001** isn't a decision in this conversation."));
    for (const fn of [repo.create, repo.update, repo.nextId, audit.append, resolver.resolveByHandleOrName, dates.parse, scheduler.cancel, scheduler.schedule]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
