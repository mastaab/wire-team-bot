import { describe, it, expect, vi } from "vitest";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import { formatIssueStatus, formatResolution, formatSla, statusLabel } from "../../src/application/usecases/jira/formatIssue";
import type { IssueSnapshot, IssueTrackerPort } from "../../src/application/ports/IssueTrackerPort";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0004",
    description: "Prepare the security questionnaire",
    rawMessageId: "",
    assigneeId: { id: "user-2", domain: "wire.com" },
    assigneeName: "Bob",
    creatorId: { id: "user-1", domain: "wire.com" },
    authorName: "Alice",
    conversationId: convId,
    deadline: null,
    status: "open",
    linkedIds: ["jira:DS-42"],
    reminderAt: [],
    completionNote: null,
    timestamp: new Date(),
    updatedAt: new Date(),
    tags: [],
    deleted: false,
    version: 1,
    ...overrides,
  };
}

const snapshot: IssueSnapshot = {
  key: "DS-42",
  url: "https://jira.test/browse/DS-42",
  summary: "Prepare the security questionnaire",
  statusCategory: "in_progress",
  slas: [
    { name: "Time to first response", state: "met", elapsed: "3m", goal: "4h" },
    { name: "Time to done", state: "running", remaining: "15h", goal: "16h" },
  ],
};

function setup(options: { found?: Action | null; queried?: Action[]; tracker?: Partial<IssueTrackerPort> } = {}) {
  const repo = {
    findById: vi.fn().mockResolvedValue(options.found === undefined ? makeAction() : options.found),
    query: vi.fn().mockResolvedValue(options.queried ?? [makeAction()]),
    update: vi.fn(),
    create: vi.fn(),
    nextId: vi.fn(),
  } satisfies ActionRepository;
  const tracker = {
    projectKey: "DS",
    createIssue: vi.fn(),
    getIssue: vi.fn().mockResolvedValue(snapshot),
    resolveIssue: vi.fn(),
    ...options.tracker,
  };
  const sent: string[] = [];
  const wire = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => { sent.push(text); }),
    getUserProfile: vi.fn(),
    sendCompositePrompt: vi.fn(),
    sendReaction: vi.fn(),
    sendFile: vi.fn(),
  };
  const useCase = new GetIssueStatus(repo, tracker, wire);
  return { repo, tracker, wire, sent, useCase };
}

describe("GetIssueStatus", () => {
  it("reads the ticket linked from an action reference", async () => {
    const { tracker, wire, sent, useCase } = setup();

    const result = await useCase.execute({ reference: "ACT-0004", conversationId: convId, replyToMessageId: "msg-1" });

    expect(result).toBe(snapshot);
    expect(tracker.getIssue).toHaveBeenCalledWith("DS-42");
    expect(sent).toEqual([formatIssueStatus(snapshot)]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it.each([
    ["missing", null],
    ["deleted", makeAction({ deleted: true })],
    ["in another conversation", makeAction({ conversationId: { id: "conv-2", domain: "wire.com" } })],
  ])("gives the identical not-found reply when the action is %s", async (_label, found) => {
    const { tracker, sent, useCase } = setup({ found });

    expect(await useCase.execute({ reference: "ACT-0004", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid I can't find **ACT-0004** in this conversation."]);
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("explains how to raise a ticket for an unlinked action", async () => {
    const { tracker, sent, useCase } = setup({ found: makeAction({ linkedIds: ["DEC-0001"] }) });

    expect(await useCase.execute({ reference: "ACT-0004", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["**ACT-0004** isn't linked to a Jira ticket yet. Use `ACT-0004 to jira` to raise one."]);
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("reads a ticket key linked from an action in this conversation", async () => {
    const { repo, tracker, sent, useCase } = setup();

    expect(await useCase.execute({ reference: "DS-42", conversationId: convId })).toBe(snapshot);

    expect(repo.query).toHaveBeenCalledWith({ conversationId: convId, linkedIdsHas: "jira:DS-42", limit: 20 });
    expect(tracker.getIssue).toHaveBeenCalledWith("DS-42");
    expect(sent).toHaveLength(1);
  });

  it("explains when an action is linked to a ticket outside the configured project", async () => {
    const { tracker, sent, useCase } = setup({ found: makeAction({ linkedIds: ["jira:SD-9"] }) });

    expect(await useCase.execute({ reference: "ACT-0004", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid **ACT-0004** is linked to **SD-9**, which is outside the DS project I can look up."]);
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("exposes the configured project key for command matching", () => {
    expect(setup().useCase.projectKey).toBe("DS");
  });

  it("refuses keys from other projects without calling the tracker", async () => {
    const { repo, tracker, sent, useCase } = setup();

    expect(await useCase.execute({ reference: "OPS-42", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid I can only look up tickets in the DS project."]);
    expect(repo.query).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["no action links it", [makeAction({ linkedIds: ["jira:DS-7"] })]],
    ["only a deleted action links it", [makeAction({ deleted: true })]],
    ["only another conversation's action links it", [makeAction({ conversationId: { id: "conv-2", domain: "wire.com" } })]],
  ])("refuses an in-project key when %s, without calling the tracker", async (_label, queried) => {
    const { tracker, sent, useCase } = setup({ queried });

    expect(await useCase.execute({ reference: "DS-42", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid **DS-42** isn't linked to an action in this conversation."]);
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("reports a ticket Jira cannot find", async () => {
    const { sent, useCase } = setup({ tracker: { getIssue: vi.fn().mockResolvedValue(null) } });

    expect(await useCase.execute({ reference: "DS-42", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't find **DS-42** in Jira."]);
  });

  it("reports an unreachable tracker", async () => {
    const { sent, useCase } = setup({ tracker: { getIssue: vi.fn().mockRejectedValue(new Error("timeout")) } });

    expect(await useCase.execute({ reference: "ACT-0004", conversationId: convId })).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't reach Jira just now."]);
  });
});

describe("formatIssue", () => {
  it("says 'under a minute' instead of Jira's rounded 0m", () => {
    expect(formatSla({ name: "Time to done", state: "met", elapsed: "0m", goal: "16h" })).toBe("Time to done: met in under a minute (target 16h)");
    expect(formatSla({ name: "Time to done", state: "met", elapsed: "3m", goal: "16h" })).toBe("Time to done: met in 3m (target 16h)");
  });

  it("labels status categories in English", () => {
    expect(statusLabel("todo")).toBe("To do");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("done")).toBe("Done");
  });

  it.each([
    [{ name: "TTD", state: "met", elapsed: "3m", goal: "16h" }, "TTD: met in 3m (target 16h)"],
    [{ name: "TTD", state: "met", goal: "16h" }, "TTD: met (target 16h)"],
    [{ name: "TTD", state: "met", elapsed: "3m" }, "TTD: met in 3m"],
    [{ name: "TTD", state: "met" }, "TTD: met"],
    [{ name: "TTD", state: "breached", goal: "16h" }, "TTD: breached (target 16h)"],
    [{ name: "TTD", state: "breached" }, "TTD: breached"],
    [{ name: "TTD", state: "running", remaining: "15h", goal: "16h" }, "TTD: running, 15h left of 16h"],
    [{ name: "TTD", state: "running", remaining: "15h" }, "TTD: running, 15h left"],
    [{ name: "TTD", state: "running", goal: "16h" }, "TTD: running (target 16h)"],
    [{ name: "TTD", state: "running" }, "TTD: running"],
    [{ name: "TTD", state: "paused", remaining: "15h", goal: "16h" }, "TTD: paused"],
  ] as const)("formats SLA %j", (sla, expected) => {
    const line = formatSla(sla);
    expect(line).toBe(expected);
    expect(line).not.toContain("undefined");
  });

  it("formats an issue status without the tracker's localised status name", () => {
    expect(formatIssueStatus(snapshot)).toBe([
      "**DS-42** Prepare the security questionnaire",
      "Status: In progress",
      "Time to first response: met in 3m (target 4h)",
      "Time to done: running, 15h left of 16h",
      "https://jira.test/browse/DS-42",
    ].join("\n"));
  });

  it("formats a successful resolution with its SLA outcome", () => {
    const done: IssueSnapshot = { ...snapshot, statusCategory: "done", slas: [{ name: "Time to done", state: "met", elapsed: "3m", goal: "16h" }] };
    expect(formatResolution(done)).toBe("Closed **DS-42** in Jira.\nTime to done: met in 3m (target 16h)");
  });

  it("reports the actual state when Done was not reached", () => {
    expect(formatResolution(snapshot)).toBe("I'm afraid I couldn't move **DS-42** to Done in Jira; it is now In progress.");
  });
});
