import { describe, it, expect, vi } from "vitest";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import type { AnswerQuestionInput } from "../../src/application/usecases/general/AnswerQuestion";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueStatusCategory, IssueTrackerPort } from "../../src/application/ports/IssueTrackerPort";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import { OFFER_TTL_MS } from "../../src/application/services/offers";
import type { PendingOffer, PendingOfferStore } from "../../src/application/services/offers";
import type { SupportRequestListOptions, SupportRequestRepository } from "../../src/domain/repositories/SupportRequestRepository";
import type { AuditLogEntry, AuditLogRepository } from "../../src/domain/repositories/AuditLogRepository";
import type { SupportRequest, SupportRequestStatusCategory } from "../../src/domain/entities/SupportRequest";
import { sameQualifiedId } from "../../src/domain/ids/QualifiedId";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const otherConv: QualifiedId = { id: "conv-2", domain: "wire.com" };
const otherDomain: QualifiedId = { id: "conv-1", domain: "other.com" };
const requester = { id: "user-1", domain: "wire.com", name: "Alice" };
const NOW = new Date("2026-09-25T10:00:00Z");

function makeRequest(key: string, overrides: Partial<SupportRequest> = {}): SupportRequest {
  const n = Number(key.split("-")[1]);
  return {
    key,
    conversationId: convId,
    requesterId: { id: "user-1", domain: "wire.com" },
    requesterName: "Alice",
    summary: `Problem ${key}`,
    statusCategory: "todo",
    // Higher numbers are newer, as in the tracker.
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, n)),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, n)),
    deleted: false,
    version: 1,
    ...overrides,
  };
}

function snapshotFor(key: string, statusCategory: IssueStatusCategory = "todo"): IssueSnapshot {
  return {
    key,
    url: `https://jira.test/browse/${key}`,
    summary: `Summary of ${key}`,
    statusCategory,
    slas: [{ name: "Time to done", state: "running", remaining: "15h", goal: "16h" }],
  };
}

interface SetupOptions {
  requests?: SupportRequest[];
  results?: RetrievalResult[];
  modelAnswer?: string;
  shareWithModel?: boolean;
  withJira?: boolean;
  tracker?: Partial<IssueTrackerPort>;
  repo?: Partial<SupportRequestRepository>;
  sendFails?: boolean;
}

/** An in-memory repository that behaves like the contract: newest first, never deleted records from lists. */
function memoryRepo(initial: SupportRequest[]) {
  const all = initial.map((r) => ({ ...r }));
  return {
    all,
    create: vi.fn(async (request: SupportRequest) => request),
    findByKey: vi.fn(async (key: string) => all.find((r) => r.key === key) ?? null),
    listByConversation: vi.fn(async (conversationId: QualifiedId, options: SupportRequestListOptions = {}) =>
      all
        .filter((r) => !r.deleted && sameQualifiedId(r.conversationId, conversationId))
        .filter((r) => !options.openOnly || r.statusCategory !== "done")
        .filter((r) => !options.requesterId || sameQualifiedId(r.requesterId, options.requesterId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, options.limit ?? 50)),
    updateStatusCategory: vi.fn(async (key: string, statusCategory: SupportRequestStatusCategory, updatedAt: Date) => {
      const found = all.find((r) => r.key === key);
      if (!found) return null;
      Object.assign(found, { statusCategory, updatedAt, version: found.version + 1 });
      return { ...found };
    }),
  } satisfies SupportRequestRepository & { all: SupportRequest[] };
}

function setup(options: SetupOptions = {}) {
  const repo = { ...memoryRepo(options.requests ?? []), ...options.repo };
  const tracker = {
    projectKey: "DS",
    createIssue: vi.fn(),
    getIssue: vi.fn(async (key: string) => snapshotFor(key)),
    resolveIssue: vi.fn(),
    listCustomerReplies: vi.fn(async (): Promise<IssueReply[]> => []),
    addCustomerReply: vi.fn(),
    ...options.tracker,
  } satisfies IssueTrackerPort;
  const audited: AuditLogEntry[] = [];
  const auditLog = { append: vi.fn(async (entry: AuditLogEntry) => { audited.push(entry); }) } satisfies AuditLogRepository;
  const stored: PendingOffer[] = [];
  const offers: PendingOfferStore = {
    put: vi.fn((offer: PendingOffer) => { stored.push(offer); }),
    take: vi.fn(() => null),
    has: vi.fn(() => false),
    clearConversation: vi.fn(),
  };
  const general = { answer: vi.fn().mockResolvedValue(options.modelAnswer ?? "Here is the answer.") };
  const sent: string[] = [];
  const wire = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => {
      if (options.sendFails) throw new Error("send failed");
      sent.push(text);
    }),
  };
  const analysis = { analyse: vi.fn().mockResolvedValue({ complexity: 0.5 }) };
  const retrieval = { retrieve: vi.fn().mockResolvedValue(options.results ?? []) };
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  const jira = options.withJira === false
    ? undefined
    : { tracker, requests: repo, auditLog, offers, shareWithModel: options.shareWithModel ?? false, now: () => NOW };
  const useCase = new AnswerQuestion(general, wire as never, analysis, retrieval, logger, jira);
  const run = (question: string, overrides: Partial<AnswerQuestionInput> = {}) => useCase.execute({
    question, conversationContext: [], conversationId: convId, replyToMessageId: "q", requester,
    members: [requester], channelId: "conv-1@wire.com", orgId: "wire.com", ...overrides,
  });
  const passedResults = (): RetrievalResult[] => general.answer.mock.calls[0]![2] as RetrievalResult[];
  const ofType = (type: RetrievalResult["type"]): RetrievalResult[] => passedResults().filter((r) => r.type === type);
  return { repo, tracker, auditLog, audited, offers, stored, general, wire, sent, logger, run, passedResults, ofType };
}

describe("AnswerQuestion with Jira: stored support requests", () => {
  it("adds this conversation's support requests with sharing off, without any tracker call", async () => {
    const requests = [
      makeRequest("DS-6", { summary: "VPN  drops\nevery ten minutes", statusCategory: "in_progress" }),
      makeRequest("DS-7", { requesterName: "", statusCategory: "done" }),
      makeRequest("DS-8", { conversationId: otherConv }),
      makeRequest("DS-9", { conversationId: otherDomain }),
      makeRequest("DS-10", { deleted: true }),
    ];
    const { tracker, run, ofType } = setup({ requests, shareWithModel: false });
    await run("Which request was the VPN one?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(ofType("jira_ticket")).toEqual([]);
    expect(ofType("support_request")).toEqual([
      {
        id: "DS-7", type: "support_request", sourceChannel: "conv-1@wire.com", sourceDate: requests[1]!.createdAt, confidence: 1, pathsMatched: ["support_requests"],
        content: "DS-7 | Summary: Problem DS-7 | Last known status: Done",
      },
      {
        id: "DS-6", type: "support_request", sourceChannel: "conv-1@wire.com", sourceDate: requests[0]!.createdAt, confidence: 1, pathsMatched: ["support_requests"],
        content: "DS-6 | Summary: VPN drops every ten minutes | Requested by: Alice | Last known status: In progress",
      },
    ]);
  });

  it("adds the requests after the retrieval results", async () => {
    const action: RetrievalResult = { id: "ACT-0001", type: "action", content: "ACT-0001", sourceChannel: "conv-1@wire.com", sourceDate: NOW, confidence: 0.9, pathsMatched: ["structured"] };
    const { run, passedResults } = setup({ requests: [makeRequest("DS-6")], results: [action] });
    await run("Anything recorded?");
    expect(passedResults().map((r) => r.id)).toEqual(["ACT-0001", "DS-6"]);
  });

  it("bounds the stored requests to the newest ten plus named keys of this conversation", async () => {
    const requests = Array.from({ length: 15 }, (_, i) => makeRequest(`DS-${i + 1}`));
    const { repo, run, ofType } = setup({ requests });
    await run("What was DS-2 about, and DS-99, and DS-14?");
    expect(repo.listByConversation).toHaveBeenCalledWith(convId, { limit: 10 });
    expect(ofType("support_request").map((r) => r.id)).toEqual(["DS-2", "DS-14", "DS-15", "DS-13", "DS-12", "DS-11", "DS-10", "DS-9", "DS-8", "DS-7", "DS-6"]);
  });

  it("never adds a named key from another channel or domain, or a deleted one", async () => {
    const requests = [
      makeRequest("DS-6"),
      makeRequest("DS-8", { conversationId: otherConv }),
      makeRequest("DS-9", { conversationId: otherDomain }),
      makeRequest("DS-10", { deleted: true }),
    ];
    const { run, ofType } = setup({ requests });
    await run("What about DS-8, DS-9, DS-10 and WPB-1?");
    expect(ofType("support_request").map((r) => r.id)).toEqual(["DS-6"]);
  });

  it("drops records the repository returns for another conversation", async () => {
    const leaked = makeRequest("DS-8", { conversationId: otherConv });
    const { run, ofType } = setup({ requests: [makeRequest("DS-6")], repo: { listByConversation: vi.fn(async () => [leaked, makeRequest("DS-6")]) } });
    await run("Anything?");
    expect(ofType("support_request").map((r) => r.id)).toEqual(["DS-6"]);
  });

  it("adds nothing and makes no repository call without Jira support", async () => {
    const { repo, run, passedResults } = setup({ withJira: false, requests: [makeRequest("DS-6")] });
    await run("What about DS-6?");
    expect(repo.listByConversation).not.toHaveBeenCalled();
    expect(passedResults()).toEqual([]);
  });

  it("answers without the requests when the lookup fails", async () => {
    const { run, passedResults, sent, logger } = setup({ repo: { listByConversation: vi.fn(async () => { throw new Error("db down"); }) } });
    await run("Anything?");
    expect(passedResults()).toEqual([]);
    expect(sent).toEqual(["Here is the answer."]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: support request lookup failed", { err: "Error" });
  });
});

describe("AnswerQuestion with Jira: live ticket data", () => {
  it("adds a compact ticket result for an open support request", async () => {
    const replies: IssueReply[] = [
      { author: "Service Desk Agent", created: new Date("2026-09-24T09:00:00Z"), body: "We are  looking\ninto it." },
      { author: "WireTeamBotDemo", created: new Date("2026-09-24T10:00:00Z"), body: "Thanks.", fromThisBot: true },
    ];
    const { tracker, run, ofType } = setup({
      requests: [makeRequest("DS-6")], shareWithModel: true,
      tracker: { listCustomerReplies: vi.fn(async () => replies) },
    });
    await run("Any news on my VPN issue?");
    expect(tracker.listCustomerReplies).toHaveBeenCalledWith("DS-6", 3);
    expect(ofType("jira_ticket")).toEqual([{
      id: "DS-6", type: "jira_ticket", sourceChannel: "conv-1@wire.com", sourceDate: NOW, confidence: 1, pathsMatched: ["jira"],
      content: [
        "DS-6: Summary of DS-6",
        "Status: To do",
        "Time to done: running, 15h left of 16h",
        "Reply from Service Desk Agent at 2026-09-24T09:00:00.000Z: We are looking into it.",
        "Reply from your team via Wire at 2026-09-24T10:00:00.000Z: Thanks.",
      ].join("\n"),
    }]);
  });

  it("says when there are no service-desk replies", async () => {
    const { run, ofType } = setup({ requests: [makeRequest("DS-6")], shareWithModel: true });
    await run("Has the service desk replied?");
    expect(ofType("jira_ticket")[0]!.content).toContain("No service-desk replies yet.");
  });

  it("uses the category label, never the tracker's status name, and truncates long replies", async () => {
    const localised = { ...snapshotFor("DS-6", "in_progress"), statusName: "In Arbeit" };
    const { run, ofType } = setup({
      requests: [makeRequest("DS-6", { statusCategory: "in_progress" })], shareWithModel: true,
      tracker: {
        getIssue: vi.fn(async () => localised),
        listCustomerReplies: vi.fn(async () => [{ author: "Agent", created: NOW, body: "x".repeat(600) }]),
      },
    });
    await run("What's the status of my request?");
    const content = ofType("jira_ticket")[0]!.content;
    expect(content).toContain("Status: In progress");
    expect(content).not.toContain("In Arbeit");
    expect(content).toContain(`: ${"x".repeat(497)}...`);
    expect(content).not.toContain("x".repeat(498));
  });

  it("makes no tracker call and adds no ticket results when sharing is off", async () => {
    const { tracker, run, ofType } = setup({ requests: [makeRequest("DS-6")], shareWithModel: false });
    await run("What's the latest on DS-6?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(ofType("jira_ticket")).toEqual([]);
    expect(ofType("support_request").map((r) => r.id)).toEqual(["DS-6"]);
  });

  it("fetches only this conversation's requests: another channel's key named in the question is not fetched", async () => {
    const requests = [
      makeRequest("DS-6"),
      makeRequest("DS-8", { conversationId: otherConv }),
      makeRequest("DS-9", { conversationId: otherDomain }),
      makeRequest("DS-10", { deleted: true }),
    ];
    const { tracker, run, ofType } = setup({ requests, shareWithModel: true });
    await run("How are DS-8, DS-9, DS-10, DS-11 and WPB-1 doing?");
    expect(tracker.getIssue.mock.calls.map((call) => call[0])).toEqual(["DS-6"]);
    expect(tracker.listCustomerReplies.mock.calls.map((call) => call[0])).toEqual(["DS-6"]);
    expect(ofType("jira_ticket").map((r) => r.id)).toEqual(["DS-6"]);
  });

  it("fetches nothing when this conversation has no support requests, even for a named key", async () => {
    const { tracker, run } = setup({ requests: [makeRequest("DS-8", { conversationId: otherConv })], shareWithModel: true });
    await run("What's the status of DS-8?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
  });

  it("caps live tickets at three, named keys first (even when done), then the newest open ones", async () => {
    const requests = [
      makeRequest("DS-1", { statusCategory: "done" }),
      makeRequest("DS-2"),
      makeRequest("DS-3"),
      makeRequest("DS-4"),
      makeRequest("DS-5", { statusCategory: "done" }),
      makeRequest("DS-6"),
    ];
    const { repo, tracker, run, ofType } = setup({ requests, shareWithModel: true, tracker: { getIssue: vi.fn(async (key: string) => snapshotFor(key, key === "DS-1" ? "done" : "todo")) } });
    await run("What's the status of ds-1 and the rest?");
    expect(repo.listByConversation).toHaveBeenCalledWith(convId, { openOnly: true, limit: 3 });
    expect(ofType("jira_ticket").map((r) => r.id)).toEqual(["DS-1", "DS-6", "DS-4"]);
    expect(tracker.getIssue).toHaveBeenCalledTimes(3);
  });

  it("deduplicates a named key that is also among the newest open requests", async () => {
    const { tracker, run, ofType } = setup({ requests: [makeRequest("DS-6")], shareWithModel: true });
    await run("What about DS-6?");
    expect(ofType("jira_ticket")).toHaveLength(1);
    expect(ofType("support_request")).toHaveLength(1);
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
  });

  it("makes no tracker call for a question unrelated to tickets", async () => {
    const { tracker, run, ofType } = setup({ requests: [makeRequest("DS-6")], shareWithModel: true });
    await run("Who owns the proposal?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(ofType("support_request").map((r) => r.id)).toEqual(["DS-6"]);
  });

  const ticketQuestions = [
    "Has the service desk replied?", "Any replies yet?", "What's the SLA on it?", "Is there a ticket for it?",
    "What does Jira say?", "Have we heard back?", "Did they answer?", "What's the progress?", "Any updates?", "STATUS please",
    "Any news on my VPN issue?", "How is my support request doing?",
  ];
  for (const question of ticketQuestions) {
    it(`fetches ticket data for a ticket-type question: "${question}"`, async () => {
      const { tracker, run } = setup({ requests: [makeRequest("DS-6")], shareWithModel: true });
      await run(question);
      expect(tracker.getIssue).toHaveBeenCalledWith("DS-6");
    });
  }

  it("skips a ticket that fails to load and still answers with the others", async () => {
    const requests = [makeRequest("DS-1"), makeRequest("DS-2"), makeRequest("DS-3")];
    const { run, ofType, sent, logger } = setup({
      requests, shareWithModel: true,
      tracker: {
        getIssue: vi.fn(async (key: string) => {
          if (key === "DS-1") throw new IssueTrackerError("Jira request failed with secret body", 503);
          return key === "DS-3" ? null : snapshotFor(key);
        }),
      },
    });
    await run("Any updates?");
    expect(ofType("jira_ticket").map((r) => r.id)).toEqual(["DS-2"]);
    expect(sent).toEqual(["Here is the answer."]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: ticket read failed", { err: "IssueTrackerError", status: 503 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret body");
  });

  it("never logs ticket content", async () => {
    const { run, logger } = setup({
      requests: [makeRequest("DS-6")], shareWithModel: true,
      tracker: { listCustomerReplies: vi.fn(async () => [{ author: "Agent", created: NOW, body: "Confidential terms" }]) },
    });
    await run("Latest?");
    const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.debug.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain("Confidential");
    expect(logged).not.toContain("Summary of DS-6");
  });

  it("never writes to Jira", async () => {
    const { tracker, run } = setup({ requests: [makeRequest("DS-6")], shareWithModel: true });
    await run("Any updates?");
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
  });
});

describe("AnswerQuestion with Jira: status refresh", () => {
  it("stores and audits a changed category, and shows the refreshed status on the stored result", async () => {
    const { repo, audited, run, ofType } = setup({
      requests: [makeRequest("DS-6", { statusCategory: "todo" })], shareWithModel: true,
      tracker: { getIssue: vi.fn(async (key: string) => snapshotFor(key, "in_progress")) },
    });
    await run("Any news on DS-6?");
    expect(repo.updateStatusCategory).toHaveBeenCalledTimes(1);
    expect(repo.updateStatusCategory).toHaveBeenCalledWith("DS-6", "in_progress", NOW);
    expect(audited).toEqual([{
      timestamp: NOW,
      actorId: { id: "wire-team-bot", domain: "wire.com" },
      conversationId: convId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: "DS-6",
      details: { statusCategory: "in_progress" },
    }]);
    expect(ofType("support_request")[0]!.content).toContain("Last known status: In progress");
  });

  it("writes nothing when the category is unchanged", async () => {
    const { repo, auditLog, run } = setup({
      requests: [makeRequest("DS-6", { statusCategory: "in_progress" })], shareWithModel: true,
      tracker: { getIssue: vi.fn(async (key: string) => snapshotFor(key, "in_progress")) },
    });
    await run("Any news on DS-6?");
    expect(repo.updateStatusCategory).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  it("writes nothing when sharing is off", async () => {
    const { repo, auditLog, run } = setup({ requests: [makeRequest("DS-6")], shareWithModel: false });
    await run("Any news on DS-6?");
    expect(repo.updateStatusCategory).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  it("audits nothing when the record disappeared before the update", async () => {
    const { auditLog, run } = setup({
      requests: [makeRequest("DS-6")], shareWithModel: true,
      tracker: { getIssue: vi.fn(async (key: string) => snapshotFor(key, "done")) },
      repo: { updateStatusCategory: vi.fn(async () => null) },
    });
    await run("Any news on DS-6?");
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  it("still answers with the live data when the refresh fails", async () => {
    const { run, ofType, sent, logger } = setup({
      requests: [makeRequest("DS-6")], shareWithModel: true,
      tracker: { getIssue: vi.fn(async (key: string) => snapshotFor(key, "done")) },
      repo: { updateStatusCategory: vi.fn(async () => { throw new Error("db down"); }) },
    });
    await run("Any news on DS-6?");
    expect(ofType("jira_ticket").map((r) => r.id)).toEqual(["DS-6"]);
    expect(ofType("support_request")[0]!.content).toContain("Last known status: To do");
    expect(sent).toEqual(["Here is the answer."]);
    expect(logger.warn).toHaveBeenCalledWith("Support request status refresh failed", { key: "DS-6", err: "Error" });
  });
});

describe("AnswerQuestion with Jira: offers", () => {
  const support = 'OFFER: {"kind":"support","summary":"VPN  drops\\nevery ten minutes","description":"My VPN drops every ten minutes since Monday."}';
  const reply = 'OFFER: {"kind":"reply","issueKey":"DS-6","body":"Alice here: it still drops.\\nThanks"}';
  const resolve = 'OFFER: {"kind":"resolve","issueKey":"DS-6"}';
  const supportQuestion = "Shall I raise this with the service desk?\n> VPN drops every ten minutes\n\n(yes or no)?";
  const replyQuestion = "Here is the reply for **DS-6**:\n> Alice here: it still drops.\n> Thanks\n\nShall I send it (yes or no)?";
  const resolveQuestion = 'Shall I resolve **DS-6** "VPN drops every ten minutes" with the service desk (yes or no)?';
  const vpn = (): SupportRequest => makeRequest("DS-6", { summary: "VPN drops  every\nten minutes", statusCategory: "in_progress" });

  it("stores a valid support offer with requester and ten-minute expiry, and asks the code-written question", async () => {
    const { stored, sent, repo, run } = setup({ modelAnswer: `I can raise that.\n${support}` });
    const answer = await run("My VPN drops every ten minutes, can you raise it with the service desk?");
    expect(stored).toEqual([{
      command: { kind: "support", summary: "VPN drops every ten minutes", description: "My VPN drops every ten minutes since Monday." },
      conversationId: convId,
      requesterId: { id: "user-1", domain: "wire.com" },
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + OFFER_TTL_MS),
    }]);
    expect(sent).toEqual([supportQuestion]);
    expect(answer).toBe(supportQuestion);
    expect(repo.findByKey).not.toHaveBeenCalled();
  });

  it("writes the reply question with the body quoted line by line, and keeps the requester's name (decision 1)", async () => {
    const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: `Here is the reply.\n${reply}` });
    await run("Tell the service desk on DS-6 that it still drops");
    expect(stored[0]!.command).toEqual({ kind: "reply", issueKey: "DS-6", body: "Alice here: it still drops.\nThanks" });
    expect(sent).toEqual([replyQuestion]);
  });

  it("writes the resolve question with the stored summary on one line", async () => {
    const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: resolve });
    await run("The VPN works again, please close my request");
    expect(stored[0]!.command).toEqual({ kind: "resolve", issueKey: "DS-6" });
    expect(sent).toEqual([resolveQuestion]);
  });

  it("ends every offer question with a question mark for the router's follow-up detection", () => {
    for (const question of [supportQuestion, replyQuestion, resolveQuestion]) expect(question.trimEnd().endsWith("?")).toBe(true);
  });

  it("sends only the code-written question, dropping the model's own offer wording", async () => {
    const { sent, run } = setup({ modelAnswer: `I've raised it with the service desk for you. Shall I?\n${support}` });
    await run("Please raise my VPN problem with the service desk");
    expect(sent).toEqual([supportQuestion]);
    expect(sent[0]).not.toContain("I've raised");
  });

  it("stores the offer only after the question was sent", async () => {
    const { offers, wire, run } = setup({ modelAnswer: support });
    await run("Raise my VPN problem");
    expect(wire.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan((offers.put as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it("stores no offer when sending the question fails", async () => {
    const { stored, offers, run } = setup({ modelAnswer: support, sendFails: true });
    await expect(run("Raise my VPN problem")).rejects.toThrow("send failed");
    expect(stored).toHaveLength(0);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it("sends an offer question without mentions, even when the quoted text names a member", async () => {
    const bob = { id: "user-2", domain: "wire.com", name: "Bob" };
    const withMention = 'OFFER: {"kind":"reply","issueKey":"DS-6","body":"@Bob will test it."}';
    const { wire, stored, run } = setup({ requests: [vpn()], modelAnswer: withMention });
    await run("Reply to DS-6 that Bob will test it", { members: [requester, bob] });
    expect(stored).toHaveLength(1);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, "Here is the reply for **DS-6**:\n> @Bob will test it.\n\nShall I send it (yes or no)?", {
      replyToMessageId: "q",
      mentions: undefined,
    });
  });

  it("never writes to Jira or the records when preparing an offer", async () => {
    const { tracker, repo, auditLog, run } = setup({ requests: [vpn()], modelAnswer: resolve });
    await run("It's fixed, resolve DS-6");
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateStatusCategory).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  describe("change intent in the question", () => {
    const markers = { support, reply, resolve } as const;
    type Kind = keyof typeof markers;
    const accepted: Array<[Kind, string]> = [
      ["support", "Can you raise my VPN problem?"],
      ["support", "Escalate this please"],
      ["support", "Open a support request for the printer"],
      ["support", "Please report this to the service desk"],
      ["support", "I need a ticket for this"],
      ["support", "Get me some support with the VPN"],
      ["resolve", "Please close my request"],
      ["resolve", "Resolve DS-6"],
      ["resolve", "The VPN works again"],
      ["resolve", "It's fixed now"],
      ["resolve", "That request is no longer needed"],
      ["reply", "Let the service desk know it still drops"],
      ["reply", "Message DS-6 that it still drops"],
      ["reply", "Answer the ticket"],
      ["reply", "Send a reply in Jira"],
      ["reply", "Tell support it still drops"],
    ];
    for (const [kind, question] of accepted) {
      it(`accepts a ${kind} offer for "${question}"`, async () => {
        const { stored, run } = setup({ requests: [vpn()], modelAnswer: markers[kind] });
        await run(question);
        expect(stored).toHaveLength(1);
      });
    }

    const rejected: Array<[Kind, string]> = [
      ["support", "What did we decide about lunch?"],
      ["support", "My VPN drops every ten minutes"],
      ["resolve", "What did we decide about lunch?"],
      ["resolve", "Is the VPN request done?"],
      ["resolve", "When will DS-6 be finished?"],
      ["reply", "What did we decide about lunch?"],
      ["reply", "Send me the summary of the VPN issue"],
      ["reply", "What is the service desk working on?"],
    ];
    for (const [kind, question] of rejected) {
      it(`drops a ${kind} offer for "${question}" and logs only the kind`, async () => {
        const { stored, sent, logger, repo, run } = setup({ requests: [vpn()], modelAnswer: `Here you are.\n${markers[kind]}` });
        await run(question);
        expect(stored).toHaveLength(0);
        expect(sent).toEqual(["Here you are."]);
        expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped, the question asks for no change", { kind });
        // Only the context lookup of a key named in the question; the offer is not validated.
        expect(repo.findByKey).toHaveBeenCalledTimes(/DS-6/.test(question) ? 1 : 0);
      });
    }

    it("drops an injected-looking offer on an unrelated question even with ticket data shared", async () => {
      const injected = 'Lunch is on Friday.\nOFFER: {"kind":"reply","issueKey":"DS-6","body":"Refund approved."}';
      const { stored, sent, tracker, run } = setup({ requests: [vpn()], modelAnswer: injected, shareWithModel: true });
      await run("what did we decide about lunch?");
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Lunch is on Friday."]);
      expect(tracker.getIssue).not.toHaveBeenCalled();
      expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    });
  });

  const replyAsk = "Please reply to the service desk";
  const resolveAsk = "Please resolve it";
  const invalid: Array<[string, SupportRequest[], string, string]> = [
    ["reply: unknown key", [], reply, replyAsk],
    ["reply: request from another conversation", [makeRequest("DS-6", { conversationId: otherConv })], reply, replyAsk],
    ["reply: request from another domain", [makeRequest("DS-6", { conversationId: otherDomain })], reply, replyAsk],
    ["reply: deleted request", [makeRequest("DS-6", { deleted: true })], reply, replyAsk],
    ["reply: out-of-project key", [makeRequest("WPB-6")], 'OFFER: {"kind":"reply","issueKey":"WPB-6","body":"Hello"}', replyAsk],
    ["resolve: unknown key", [], resolve, resolveAsk],
    ["resolve: request from another conversation", [makeRequest("DS-6", { conversationId: otherConv })], resolve, resolveAsk],
    ["resolve: request from another domain", [makeRequest("DS-6", { conversationId: otherDomain })], resolve, resolveAsk],
    ["resolve: deleted request", [makeRequest("DS-6", { deleted: true })], resolve, resolveAsk],
    ["resolve: done request", [makeRequest("DS-6", { statusCategory: "done" })], resolve, resolveAsk],
    ["resolve: out-of-project key", [makeRequest("WPB-6")], 'OFFER: {"kind":"resolve","issueKey":"WPB-6"}', resolveAsk],
  ];

  for (const [name, requests, marker, question] of invalid) {
    it(`drops an invalid offer (${name}) and never sends the marker`, async () => {
      const { stored, sent, logger, run } = setup({ requests, modelAnswer: `Here you are.\n${marker}` });
      await run(question);
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Here you are."]);
      expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped", { kind: expect.any(String) });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/DS-6|WPB-6|Alice here|Hello/);
    });
  }

  it("allows a reply to a done request", async () => {
    const { stored, run } = setup({ requests: [makeRequest("DS-6", { statusCategory: "done" })], modelAnswer: reply });
    await run(replyAsk);
    expect(stored).toHaveLength(1);
  });

  it("drops an offer that fails bounds in the parser, and hides the marker", async () => {
    const long = `OFFER: ${JSON.stringify({ kind: "support", summary: "s".repeat(121), description: "It breaks." })}`;
    const { stored, sent, run } = setup({ modelAnswer: `Here you are.\n${long}` });
    await run("Raise this with the service desk");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["Here you are."]);
  });

  it("rejects the old raise and close kinds", async () => {
    for (const marker of ['OFFER: {"kind":"raise","actionId":"ACT-0010"}', 'OFFER: {"kind":"close","actionId":"ACT-0010"}']) {
      const { stored, sent, run } = setup({ modelAnswer: `Here you are.\n${marker}` });
      await run("Raise it in Jira and close it");
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Here you are."]);
    }
  });

  for (const [kind, marker, question] of [
    ["support", support, "Raise my VPN problem with the service desk"],
    ["reply", reply, replyAsk],
    ["resolve", resolve, resolveAsk],
  ] as const) {
    it(`drops a ${kind} offer when the requester is unknown`, async () => {
      const { stored, sent, repo, run } = setup({ requests: [vpn()], modelAnswer: `Here you are.\n${marker}` });
      await run(question, { requester: undefined });
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Here you are."]);
      expect(repo.findByKey.mock.calls.map((call) => call[0])).not.toContain("DS-6");
    });

    it(`drops a ${kind} offer when the requester has no domain`, async () => {
      const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: `Here you are.\n${marker}` });
      await run(question, { requester: { id: "user-1", name: "Alice" } });
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Here you are."]);
    });
  }

  it("drops the offer when the record lookup fails", async () => {
    const { stored, sent, logger, run } = setup({ modelAnswer: `Here you are.\n${resolve}`, repo: { findByKey: vi.fn(async () => { throw new Error("db down"); }) } });
    await run(resolveAsk);
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["Here you are."]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer validation failed", { kind: "resolve", err: "Error" });
  });

  it("strips a malformed marker and marker lines that are not last", async () => {
    const { stored, sent, run } = setup({ modelAnswer: `${support}\nThe answer.\nOFFER: {not json` });
    await run("Raise it with the service desk");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["The answer."]);
  });

  it("sends the fallback when the model wrote nothing but an invalid marker", async () => {
    const { sent, run } = setup({ modelAnswer: 'OFFER: {"kind":"resolve","issueKey":"DS-6"}' });
    await run("Resolve DS-6");
    expect(sent).toEqual(["I wasn't able to generate a response."]);
  });

  it("sends only the question when the model wrote nothing but the marker", async () => {
    const { sent, run } = setup({ modelAnswer: support });
    await run("Raise my VPN problem");
    expect(sent).toEqual([supportQuestion]);
  });

  it("creates offers whether or not ticket sharing is on", async () => {
    for (const shareWithModel of [false, true]) {
      const { stored, tracker, run } = setup({ modelAnswer: support, shareWithModel });
      await run("Raise my VPN problem");
      expect(stored).toHaveLength(1);
      expect(tracker.createIssue).not.toHaveBeenCalled();
    }
  });

  it("extracts mentions from the final text", async () => {
    // No valid offer here, so the model's text is sent, minus the stray marker line.
    const { wire, run } = setup({ modelAnswer: `OFFER: stray\n@Alice owns it.` });
    const final = await run("Who owns the proposal?");
    expect(final).toBe("@Alice owns it.");
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, final, {
      replyToMessageId: "q",
      mentions: [{ userId: { id: "user-1", domain: "wire.com" }, offset: 0, length: "@Alice".length }],
    });
  });

  it("sends the answer unchanged when Jira support is absent, even with a marker-like line", async () => {
    const answer = `Here you are.\n${support}`;
    const { stored, sent, run } = setup({ withJira: false, modelAnswer: answer });
    await run("Raise it");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual([answer]);
  });
});
