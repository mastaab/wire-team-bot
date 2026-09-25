import { describe, it, expect, vi } from "vitest";
import { ReplyToServiceDesk } from "../../src/application/usecases/jira/ReplyToServiceDesk";
import { REPLY_BODY_MAX } from "../../src/application/services/offers";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../src/application/ports/IssueTrackerPort";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const actorId: QualifiedId = { id: "user-1", domain: "wire.com" };
const BODY_MARKER = "SECRET-BODY-MARKER";

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0004",
    description: "Prepare the security questionnaire",
    rawMessageId: "",
    assigneeId: { id: "user-2", domain: "wire.com" },
    assigneeName: "Bob",
    creatorId: actorId,
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
    getIssue: vi.fn(),
    resolveIssue: vi.fn(),
    listCustomerReplies: vi.fn(),
    addCustomerReply: vi.fn().mockResolvedValue(undefined),
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
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  const useCase = new ReplyToServiceDesk(repo, tracker, wire, audit, logger);
  return { repo, tracker, wire, sent, audit, logger, useCase };
}

const base = { conversationId: convId, actorId, replyToMessageId: "msg-1" };

describe("ReplyToServiceDesk", () => {
  it("sends the reply with the footer to the ticket linked from an action and audits it without the body", async () => {
    const { tracker, wire, sent, audit, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "act-0004", body: "  Section 3 is attached.  " })).toBe(true);

    expect(tracker.addCustomerReply).toHaveBeenCalledTimes(1);
    expect(tracker.addCustomerReply).toHaveBeenCalledWith("DS-42", "Section 3 is attached.\n\nSent from Wire (ACT-0004).");
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_created",
      entityType: "JiraComment",
      entityId: "DS-42",
      actorId,
      conversationId: convId,
      details: { actionId: "ACT-0004" },
    }));
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain("Section 3");
    expect(sent).toEqual(["Sent your reply to **DS-42** in Jira."]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("sends to a key linked from an action in this conversation, naming that action in the footer", async () => {
    const { repo, tracker, sent, audit, useCase } = setup({
      queried: [
        makeAction({ id: "ACT-0001", deleted: true }),
        makeAction({ id: "ACT-0002", conversationId: { id: "conv-1", domain: "other.example" } }),
        makeAction({ id: "ACT-0007" }),
      ],
    });

    expect(await useCase.execute({ ...base, reference: "ds-42", body: "Thanks, we will review it." })).toBe(true);

    expect(repo.query).toHaveBeenCalledWith({ conversationId: convId, linkedIdsHas: "jira:DS-42", limit: 20 });
    expect(repo.findById).not.toHaveBeenCalled();
    expect(tracker.addCustomerReply).toHaveBeenCalledWith("DS-42", "Thanks, we will review it.\n\nSent from Wire (ACT-0007).");
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ details: { actionId: "ACT-0007" } }));
    expect(sent).toEqual(["Sent your reply to **DS-42** in Jira."]);
  });

  it("never includes the requester's or owner's name in what is sent", async () => {
    const { tracker, useCase } = setup({ found: makeAction({ authorName: "Alice Requester", assigneeName: "Bob Owner" }) });

    await useCase.execute({ ...base, reference: "ACT-0004", body: "Here is the form." });

    const sentToTracker = JSON.stringify(tracker.addCustomerReply.mock.calls);
    expect(sentToTracker).not.toContain("Alice");
    expect(sentToTracker).not.toContain("Bob");
    expect(sentToTracker).not.toContain(actorId.id);
  });

  it.each([
    ["missing", null],
    ["deleted", makeAction({ deleted: true })],
    ["in another conversation", makeAction({ conversationId: { id: "conv-2", domain: "wire.com" } })],
    ["in the same conversation ID on another domain", makeAction({ conversationId: { id: "conv-1", domain: "other.example" } })],
  ])("gives the identical not-found reply when the action is %s, without calling the tracker", async (_label, found) => {
    const { tracker, sent, audit, useCase } = setup({ found });

    expect(await useCase.execute({ ...base, reference: "ACT-0004", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["I'm afraid I can't find **ACT-0004** in this conversation."]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("explains how to raise a ticket for an unlinked action", async () => {
    const { tracker, sent, useCase } = setup({ found: makeAction({ linkedIds: ["DEC-0001"] }) });

    expect(await useCase.execute({ ...base, reference: "ACT-0004", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["**ACT-0004** isn't linked to a Jira ticket yet. Use `ACT-0004 to jira` to raise one."]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it("refuses an action linked to a ticket outside the project", async () => {
    const { tracker, sent, useCase } = setup({ found: makeAction({ linkedIds: ["jira:SD-9"] }) });

    expect(await useCase.execute({ ...base, reference: "ACT-0004", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["I'm afraid **ACT-0004** is linked to **SD-9**, which is outside the DS project I can reply to."]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it("refuses keys from other projects without querying or calling the tracker", async () => {
    const { repo, tracker, sent, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "OPS-42", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["I'm afraid I can only reply to tickets in the DS project."]);
    expect(repo.query).not.toHaveBeenCalled();
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it.each([
    ["no action links it", [makeAction({ linkedIds: ["jira:DS-7"] })]],
    ["only a deleted action links it", [makeAction({ deleted: true })]],
    ["only another conversation's action links it", [makeAction({ conversationId: { id: "conv-2", domain: "wire.com" } })]],
    ["nothing is returned", []],
  ])("refuses an in-project key when %s, without calling the tracker", async (_label, queried) => {
    const { tracker, sent, useCase } = setup({ queried });

    expect(await useCase.execute({ ...base, reference: "DS-42", body: "Hello" })).toBe(false);

    expect(sent).toEqual(["I'm afraid **DS-42** isn't linked to an action in this conversation."]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it.each(["", "   \n\t "])("refuses an empty body %j", async (body) => {
    const { tracker, sent, useCase } = setup();

    expect(await useCase.execute({ ...base, reference: "ACT-0004", body })).toBe(false);

    expect(sent).toEqual(["I'm afraid there is nothing to send."]);
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly the limit and refuses one character more", async () => {
    const atLimit = setup();
    expect(await atLimit.useCase.execute({ ...base, reference: "ACT-0004", body: "x".repeat(REPLY_BODY_MAX) })).toBe(true);
    expect(atLimit.tracker.addCustomerReply).toHaveBeenCalledTimes(1);

    const over = setup();
    expect(await over.useCase.execute({ ...base, reference: "ACT-0004", body: "x".repeat(REPLY_BODY_MAX + 1) })).toBe(false);
    expect(over.sent).toEqual([`I'm afraid that reply is too long for Jira; please keep it under ${REPLY_BODY_MAX} characters.`]);
    expect(over.tracker.addCustomerReply).not.toHaveBeenCalled();
  });

  it("reports a failed send, logs only the error fields and does not audit", async () => {
    const { sent, audit, logger, useCase } = setup({
      tracker: { addCustomerReply: vi.fn().mockRejectedValue(new IssueTrackerError(`failed ${BODY_MARKER}`, 500)) },
    });

    expect(await useCase.execute({ ...base, reference: "ACT-0004", body: `Please see ${BODY_MARKER}` })).toBe(false);

    expect(sent).toEqual(["I'm afraid I couldn't send the reply to **DS-42** just now."]);
    expect(audit.append).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("ReplyToServiceDesk: addCustomerReply failed", { err: "IssueTrackerError", status: 500 });
  });

  it("never logs the body on any path", async () => {
    const paths = [
      setup(),
      setup({ tracker: { addCustomerReply: vi.fn().mockRejectedValue(new Error(BODY_MARKER)) } }),
      setup({ found: null }),
    ];
    for (const { logger, useCase } of paths) {
      await useCase.execute({ ...base, reference: "ACT-0004", body: `Reply ${BODY_MARKER}` });
      const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.debug.mock.calls, logger.error.mock.calls]);
      expect(logged).not.toContain(BODY_MARKER);
    }
  });

  it("sends exactly one Wire message per call", async () => {
    const cases = [
      setup(),
      setup({ found: null }),
      setup({ tracker: { addCustomerReply: vi.fn().mockRejectedValue(new Error("x")) } }),
    ];
    for (const { wire, useCase } of cases) {
      await useCase.execute({ ...base, reference: "ACT-0004", body: "Hello" });
      expect(wire.sendPlainText).toHaveBeenCalledTimes(1);
    }
  });
});
