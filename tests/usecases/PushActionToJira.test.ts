import { describe, it, expect, vi } from "vitest";
import { PushActionToJira } from "../../src/application/usecases/jira/PushActionToJira";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../src/application/ports/IssueTrackerPort";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const actorId: QualifiedId = { id: "user-1", domain: "wire.com" };
const MARKER = "SECRET-CONVERSATION-MARKER";

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0004",
    description: "Prepare the security questionnaire",
    rawMessageId: MARKER,
    assigneeId: { id: "user-2", domain: "wire.com" },
    assigneeName: "Bob",
    creatorId: actorId,
    authorName: MARKER,
    conversationId: convId,
    deadline: null,
    status: "open",
    linkedIds: ["DEC-0001"],
    reminderAt: [],
    completionNote: MARKER,
    timestamp: new Date(),
    updatedAt: new Date(),
    tags: [MARKER],
    deleted: false,
    version: 3,
    sourceRef: { wire_msg_ids: [MARKER], timestamp_range: { start: MARKER, end: MARKER } },
    ...overrides,
  };
}

function setup(action: Action | null, trackerOverrides: Partial<IssueTrackerPort> = {}) {
  const repo = {
    findById: vi.fn().mockResolvedValue(action),
    update: vi.fn(async (a: Action) => a),
    create: vi.fn(),
    query: vi.fn(),
    nextId: vi.fn(),
  } satisfies ActionRepository;
  const tracker = {
    projectKey: "DS",
    createIssue: vi.fn().mockResolvedValue({ key: "DS-42", url: "https://jira.test/browse/DS-42", fieldsApplied: true }),
    getIssue: vi.fn().mockResolvedValue(null),
    resolveIssue: vi.fn(),
    ...trackerOverrides,
  };
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
  const useCase = new PushActionToJira(repo, tracker, wire, audit, logger);
  return { repo, tracker, wire, sent, audit, logger, useCase };
}

const input = {
  actionId: "ACT-0004",
  conversationId: convId,
  actorId,
  timezone: "Europe/Berlin",
  replyToMessageId: "msg-1",
};

describe("PushActionToJira", () => {
  it("creates a ticket, links it, audits both writes and replies once", async () => {
    const { repo, tracker, wire, sent, audit, useCase } = setup(makeAction());

    const result = await useCase.execute(input);

    expect(result).toEqual({ key: "DS-42", url: "https://jira.test/browse/DS-42" });
    expect(tracker.createIssue).toHaveBeenCalledWith({
      summary: "Prepare the security questionnaire",
      description: "Prepare the security questionnaire\n\nOwner: Bob\nRaised from Wire (ACT-0004).",
      labels: ["wire-team-bot"],
    });
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({
      id: "ACT-0004",
      linkedIds: ["DEC-0001", "jira:DS-42"],
      version: 4,
    }));
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "entity_created", entityType: "JiraIssue", entityId: "DS-42", actorId, conversationId: convId, details: { actionId: "ACT-0004" },
    }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "entity_updated", entityType: "Action", entityId: "ACT-0004", details: { linkedJiraKey: "DS-42" },
    }));
    expect(sent).toEqual(["Created **DS-42** in Jira and linked it to **ACT-0004**: https://jira.test/browse/DS-42"]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it.each([
    ["missing", null],
    ["deleted", makeAction({ deleted: true })],
    ["in another conversation", makeAction({ conversationId: { id: "conv-2", domain: "wire.com" } })],
    ["in another domain", makeAction({ conversationId: { id: "conv-1", domain: "other.test" } })],
  ])("gives the identical not-found reply when the action is %s", async (_label, action) => {
    const { repo, tracker, sent, audit, useCase } = setup(action);

    expect(await useCase.execute(input)).toBeNull();

    expect(sent).toEqual(["I'm afraid I can't find **ACT-0004** in this conversation."]);
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"] as const)("refuses a %s action", async status => {
    const { tracker, sent, useCase } = setup(makeAction({ status }));

    expect(await useCase.execute(input)).toBeNull();

    expect(sent).toEqual([`I'm afraid **ACT-0004** is already ${status}; only open actions can be raised in Jira.`]);
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("never creates a second ticket for an already linked action", async () => {
    const { repo, tracker, sent, audit, useCase } = setup(makeAction({ linkedIds: ["jira:DS-7"] }), {
      getIssue: vi.fn().mockResolvedValue({ key: "DS-7", url: "https://jira.test/browse/DS-7", summary: "x", statusCategory: "todo", slas: [] }),
    });

    expect(await useCase.execute(input)).toBeNull();

    expect(tracker.getIssue).toHaveBeenCalledWith("DS-7");
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(sent).toEqual(["**ACT-0004** is already linked to **DS-7**: https://jira.test/browse/DS-7"]);
  });

  it.each([
    ["returns null", vi.fn().mockResolvedValue(null)],
    ["throws", vi.fn().mockRejectedValue(new IssueTrackerError("boom", 503))],
  ])("omits the url for an already linked action when the lookup %s", async (_label, getIssue) => {
    const { tracker, sent, useCase } = setup(makeAction({ linkedIds: ["jira:DS-7"] }), { getIssue });

    expect(await useCase.execute(input)).toBeNull();

    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(sent).toEqual(["**ACT-0004** is already linked to **DS-7**."]);
  });

  it("sends only the action's own fields, never surrounding data", async () => {
    const { tracker, useCase } = setup(makeAction({ deadline: new Date("2026-09-25T10:00:00Z") }));

    await useCase.execute(input);

    const request = tracker.createIssue.mock.calls[0][0];
    expect(JSON.stringify(request)).not.toContain(MARKER);
    expect(request.description).toBe(
      "Prepare the security questionnaire\n\nOwner: Bob\nDue: 2026-09-25\nRaised from Wire (ACT-0004).",
    );
    expect(request.dueDate).toBe("2026-09-25");
  });

  it.each([
    ["a raw UUID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["empty", "  "],
  ])("reports the owner as unassigned when the assignee name is %s", async (_label, assigneeName) => {
    const { tracker, useCase } = setup(makeAction({ assigneeName }));

    await useCase.execute(input);

    const request = tracker.createIssue.mock.calls[0][0];
    expect(request.description).toContain("Owner: unassigned");
    expect(request.description).not.toContain(assigneeName.trim() || "Owner:  ");
  });

  it("passes the trimmed description as the summary and leaves Jira's length limit to the adapter", async () => {
    const { tracker, useCase } = setup(makeAction({ description: `  ${"a".repeat(300)}  ` }));

    await useCase.execute(input);

    const request = tracker.createIssue.mock.calls[0][0];
    expect(request.summary).toBe("a".repeat(300));
    expect(request.description.startsWith(`${"a".repeat(300)}\n`)).toBe(true);
  });

  it("never sends the requester's name to Jira", async () => {
    const { tracker, useCase } = setup(makeAction());

    await useCase.execute(input);

    expect(tracker.createIssue.mock.calls[0][0].description).not.toMatch(/Raised from Wire by/);
  });

  it("links the ticket onto the action as it is after the tracker call, keeping changes made meanwhile", async () => {
    const { repo, useCase } = setup(makeAction());
    const changedMeanwhile = makeAction({ status: "done", version: 5, deadline: new Date("2026-10-02T12:00:00Z") });
    repo.findById.mockResolvedValueOnce(makeAction()).mockResolvedValueOnce(changedMeanwhile);

    await useCase.execute(input);

    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "done", version: 6, deadline: changedMeanwhile.deadline, linkedIds: ["DEC-0001", "jira:DS-42"],
    }));
  });

  it("creates only one ticket when the same action is raised twice concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { tracker, sent, useCase } = setup(makeAction(), {
      createIssue: vi.fn(async () => { await gate; return { key: "DS-42", url: "https://jira.test/browse/DS-42", fieldsApplied: true }; }),
    });

    const first = useCase.execute(input);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await useCase.execute(input);
    release();
    await first;

    expect(second).toBeNull();
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
    expect(sent).toContain("**ACT-0004** is already being raised in Jira.");
  });

  it("allows the action to be raised again after an attempt has finished", async () => {
    const { tracker, useCase } = setup(makeAction(), {
      createIssue: vi.fn().mockRejectedValueOnce(new IssueTrackerError("Jira request failed (503)", 503))
        .mockResolvedValueOnce({ key: "DS-43", url: "https://jira.test/browse/DS-43", fieldsApplied: true }),
    });

    expect(await useCase.execute(input)).toBeNull();
    expect(await useCase.execute(input)).toEqual({ key: "DS-43", url: "https://jira.test/browse/DS-43" });
    expect(tracker.createIssue).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Europe/Berlin", "2026-09-26"],
    ["UTC", "2026-09-25"],
    ["Not/AZone", "2026-09-25"],
  ])("resolves the due date as a calendar date in %s", async (timezone, expected) => {
    const { tracker, useCase } = setup(makeAction({ deadline: new Date("2026-09-25T22:30:00Z") }));

    await useCase.execute({ ...input, timezone });

    const request = tracker.createIssue.mock.calls[0][0];
    expect(request.dueDate).toBe(expected);
    expect(request.description).toContain(`Due: ${expected}`);
  });

  it("keeps an evening deadline on the same day in a UTC+2 channel", async () => {
    const { tracker, useCase } = setup(makeAction({ deadline: new Date("2026-09-25T19:00:00Z") }));

    await useCase.execute(input);

    expect(tracker.createIssue.mock.calls[0][0].dueDate).toBe("2026-09-25");
  });

  it("leaves the action unchanged when the tracker fails, logging only the error name and status", async () => {
    const { repo, sent, audit, logger, useCase } = setup(makeAction(), {
      createIssue: vi.fn().mockRejectedValue(new IssueTrackerError("response body with secrets", 500)),
    });

    expect(await useCase.execute(input)).toBeNull();

    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(sent).toEqual(["I'm afraid I couldn't create a Jira ticket just now. **ACT-0004** is unchanged."]);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "IssueTrackerError", status: 500 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secrets");
  });

  it("reports a created but unlinked ticket when saving the link fails", async () => {
    const { repo, sent, audit, useCase } = setup(makeAction());
    repo.update.mockRejectedValueOnce(new Error("db down"));

    const result = await useCase.execute(input);

    expect(result).toEqual({ key: "DS-42", url: "https://jira.test/browse/DS-42" });
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: "entity_created", entityId: "DS-42" }));
    expect(sent).toEqual([
      "Created **DS-42** in Jira (https://jira.test/browse/DS-42), but I'm afraid I couldn't link it to **ACT-0004**.",
    ]);
  });

  it.each([
    ["with a deadline", new Date("2026-09-25T10:00:00Z"), "due date and label"],
    ["without a deadline", null, "label"],
  ])("says which fields could not be set %s", async (_label, deadline, fields) => {
    const { sent, useCase } = setup(makeAction({ deadline }), {
      createIssue: vi.fn().mockResolvedValue({ key: "DS-42", url: "https://jira.test/browse/DS-42", fieldsApplied: false }),
    });

    await useCase.execute(input);

    expect(sent).toEqual([
      `Created **DS-42** in Jira and linked it to **ACT-0004**: https://jira.test/browse/DS-42\nI'm afraid I couldn't set the ${fields} on the ticket.`,
    ]);
  });
});
