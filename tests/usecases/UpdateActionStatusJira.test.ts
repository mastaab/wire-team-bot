import { describe, it, expect, vi } from "vitest";
import { UpdateActionStatus } from "../../src/application/usecases/actions/UpdateActionStatus";
import type { ActionStatusUpdate } from "../../src/application/usecases/actions/UpdateActionStatus";
import type { IssueSnapshot } from "../../src/application/ports/IssueTrackerPort";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const actorId: QualifiedId = { id: "user-1", domain: "wire.com" };

function makeAction(linkedIds: string[], status: Action["status"] = "open"): Action {
  return {
    id: "ACT-0004",
    description: "Prepare the security questionnaire",
    rawMessageId: "",
    assigneeId: actorId,
    assigneeName: "Bob",
    creatorId: actorId,
    authorName: "Alice",
    conversationId: convId,
    deadline: null,
    status,
    linkedIds,
    reminderAt: [],
    completionNote: null,
    timestamp: new Date(),
    updatedAt: new Date(),
    tags: [],
    deleted: false,
    version: 1,
  };
}

const resolved: IssueSnapshot = {
  key: "DS-42",
  url: "https://jira.test/browse/DS-42",
  summary: "Prepare the security questionnaire",
  statusCategory: "done",
  slas: [
    { name: "Time to first response", state: "met", elapsed: "3m", goal: "4h" },
    { name: "Time to done", state: "met", elapsed: "3m", goal: "16h" },
  ],
};

function setup(linkedIds: string[], withTracker: boolean, resolveIssue = vi.fn().mockResolvedValue(resolved), initialStatus: Action["status"] = "open") {
  const repo = {
    findById: vi.fn().mockResolvedValue(makeAction(linkedIds, initialStatus)),
    update: vi.fn(async (a: Action) => a),
    create: vi.fn(),
    query: vi.fn(),
    nextId: vi.fn(),
  } satisfies ActionRepository;
  const tracker = { projectKey: "DS", createIssue: vi.fn(), getIssue: vi.fn(), resolveIssue };
  const sent: string[] = [];
  const wire = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => { sent.push(text); }),
    getUserProfile: vi.fn(),
    sendCompositePrompt: vi.fn(),
    sendReaction: vi.fn(),
    sendFile: vi.fn(),
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  const useCase = withTracker
    ? new UpdateActionStatus(repo, wire, audit, tracker, logger)
    : new UpdateActionStatus(repo, wire, audit);
  return { repo, tracker, wire, sent, audit, logger, useCase };
}

const run = (useCase: UpdateActionStatus, newStatus: ActionStatusUpdate) =>
  useCase.execute({ actionId: "ACT-0004", newStatus, conversationId: convId, actorId, replyToMessageId: "msg-1" });

describe("UpdateActionStatus with an issue tracker", () => {
  it("keeps the base message when no tracker is configured", async () => {
    const { sent, useCase } = setup(["jira:DS-42"], false);

    await run(useCase, "done");

    expect(sent).toEqual(["**ACT-0004** marked as `done`."]);
  });

  it.each([
    ["not linked", ["DEC-0001"]],
    ["linked to another project", ["jira:OPS-9"]],
  ])("does not call the tracker when the action is %s", async (_label, linkedIds) => {
    const { tracker, sent, useCase } = setup(linkedIds, true);

    await run(useCase, "done");

    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(sent).toEqual(["**ACT-0004** marked as `done`."]);
  });

  it.each(["open", "in_progress", "cancelled", "overdue"] as const)("does not call the tracker for %s", async status => {
    const { tracker, sent, useCase } = setup(["jira:DS-42"], true);

    await run(useCase, status);

    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(sent).toEqual([`**ACT-0004** marked as \`${status}\`.`]);
  });

  it("confirms in Wire first, then resolves the linked ticket and reports it in a follow-up", async () => {
    const { repo, tracker, wire, sent, audit, useCase } = setup(["jira:DS-42"], true);

    const result = await run(useCase, "done");

    expect(result?.status).toBe("done");
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ status: "done", version: 2 }));
    expect(tracker.resolveIssue).toHaveBeenCalledWith("DS-42");
    expect(sent).toEqual([
      "**ACT-0004** marked as `done`.",
      ["Closed **DS-42** in Jira.", "Time to first response: met in 3m (target 4h)", "Time to done: met in 3m (target 16h)"].join("\n"),
    ]);
    expect(wire.sendPlainText.mock.invocationCallOrder[0]).toBeLessThan(tracker.resolveIssue.mock.invocationCallOrder[0]);
    expect(wire.sendPlainText).toHaveBeenNthCalledWith(2, convId, sent[1], { replyToMessageId: "msg-1" });
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({ entityType: "Action", entityId: "ACT-0004" }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "entity_updated", entityType: "JiraIssue", entityId: "DS-42", details: { statusCategory: "done" },
    }));
  });

  it("does not touch the ticket or claim a close when the action was already done", async () => {
    const { tracker, sent, audit, useCase } = setup(["jira:DS-42"], true, undefined, "done");

    await run(useCase, "done");

    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(sent).toEqual(["**ACT-0004** marked as `done`."]);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it("reports the actual state when the ticket did not reach Done", async () => {
    const { sent, useCase } = setup(["jira:DS-42"], true, vi.fn().mockResolvedValue({ ...resolved, statusCategory: "in_progress" }));

    await run(useCase, "done");

    expect(sent).toEqual([
      "**ACT-0004** marked as `done`.",
      "I'm afraid I couldn't move **DS-42** to Done in Jira; it is now In progress.",
    ]);
  });

  it("still updates the action, logs, and audits the failed attempt when resolving fails", async () => {
    const { repo, sent, audit, logger, useCase } = setup(["jira:DS-42"], true, vi.fn().mockRejectedValue(new Error("SECRET-BODY")));

    const result = await run(useCase, "done");

    expect(result?.status).toBe("done");
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({ entityType: "Action", details: { newStatus: "done" } }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      entityType: "JiraIssue", entityId: "DS-42", details: { outcome: "resolve_failed" },
    }));
    expect(logger.warn).toHaveBeenCalledWith("UpdateActionStatus: resolveIssue failed", { key: "DS-42", err: "Error" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("SECRET-BODY");
    expect(sent).toEqual([
      "**ACT-0004** marked as `done`.",
      "I'm afraid I couldn't close **DS-42** in Jira; please check it there.",
    ]);
  });
});
