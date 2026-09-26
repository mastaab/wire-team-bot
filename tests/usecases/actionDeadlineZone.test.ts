import { describe, it, expect, vi } from "vitest";
import { ListMyActions } from "../../src/application/usecases/actions/ListMyActions";
import { ListTeamActions } from "../../src/application/usecases/actions/ListTeamActions";
import { ListOverdueActions } from "../../src/application/usecases/actions/ListOverdueActions";
import { CheckStaleness } from "../../src/application/usecases/actions/CheckStaleness";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { Action } from "../../src/domain/entities/Action";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const alice: QualifiedId = { id: "user-1", domain: "wire.com" };
// 23:30 UTC on 31 March is already 1 April in Berlin.
const deadline = new Date("2026-03-31T23:30:00Z");

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0001", description: "Deploy", rawMessageId: "", assigneeId: alice, assigneeName: "Alice", creatorId: alice,
    authorName: "Alice", conversationId: convId, deadline, status: "open", linkedIds: [], reminderAt: [], completionNote: null,
    timestamp: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"), tags: [], deleted: false, version: 1,
    ...overrides,
  };
}

function setup(actions: Action[]) {
  const repo: ActionRepository = { nextId: vi.fn(), create: vi.fn(), update: vi.fn(), findById: vi.fn(), query: vi.fn().mockResolvedValue(actions) };
  const sent: string[] = [];
  const wire = { sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => { sent.push(text); }) };
  return { repo, wire: wire as never, sent };
}

describe("action lists show deadline dates in the channel's timezone", () => {
  it("ListMyActions", async () => {
    const { repo, wire, sent } = setup([action()]);
    await new ListMyActions(repo, wire).execute({ conversationId: convId, assigneeId: alice, timezone: "Europe/Berlin" });
    expect(sent[0]).toContain("_(due 2026-04-01)_");
  });

  it("ListTeamActions", async () => {
    const { repo, wire, sent } = setup([action()]);
    await new ListTeamActions(repo, wire).execute({ conversationId: convId, timezone: "Europe/Berlin" });
    expect(sent[0]).toContain("_(due 2026-04-01)_");
  });

  it("ListOverdueActions", async () => {
    const { repo, wire, sent } = setup([action({ status: "overdue" })]);
    await new ListOverdueActions(repo, wire).execute({ conversationId: convId, timezone: "Europe/Berlin" });
    expect(sent[0]).toContain("_(due 2026-04-01)_");
  });

  it("uses UTC when no timezone is given", async () => {
    const { repo, wire, sent } = setup([action()]);
    await new ListMyActions(repo, wire).execute({ conversationId: convId, assigneeId: alice });
    expect(sent[0]).toContain("_(due 2026-03-31)_");
  });
});

describe("CheckStaleness shows the deadline date in the channel's timezone", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };

  it.each([["Europe/Berlin", "2026-04-01"], ["America/New_York", "2026-03-31"]])("in %s", async (timezone, date) => {
    const actionRepo = { query: vi.fn().mockResolvedValue([action({ stalenessAt: null, lastStatusCheck: null })]), update: vi.fn() };
    const wire = { sendPlainText: vi.fn() };
    const channelConfig = { get: vi.fn().mockResolvedValue({ state: "active", timezone }) };
    await new CheckStaleness(actionRepo as never, wire as never, logger, channelConfig as never, { append: vi.fn() }).execute();
    expect(channelConfig.get).toHaveBeenCalledWith("conv-1@wire.com");
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, expect.stringContaining(`to complete _Deploy_ by ${date}.`));
  });
});
