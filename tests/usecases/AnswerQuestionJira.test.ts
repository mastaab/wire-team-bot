import { describe, it, expect, vi } from "vitest";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import type { AnswerQuestionInput } from "../../src/application/usecases/general/AnswerQuestion";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueStatusCategory, IssueTrackerPort } from "../../src/application/ports/IssueTrackerPort";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import { OFFER_TTL_MS, formatReplyQuestion } from "../../src/application/services/offers";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../src/application/services/offers";
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
    kind: "fault",
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
  passive?: boolean;
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
    drop: vi.fn(() => null),
    recentlyDropped: vi.fn(() => null),
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
    : { tracker, requests: repo, auditLog, offers, shareWithModel: options.shareWithModel ?? false, passive: options.passive, now: () => NOW };
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
        content: "DS-7 | Summary: Problem DS-7 | Kind: fault | Last known status: Done",
      },
      {
        id: "DS-6", type: "support_request", sourceChannel: "conv-1@wire.com", sourceDate: requests[0]!.createdAt, confidence: 1, pathsMatched: ["support_requests"],
        content: "DS-6 | Summary: VPN drops every ten minutes | Kind: fault | Requested by: Alice | Last known status: In progress",
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

  it("drops stored records whose key is outside the configured project, and never fetches them", async () => {
    const foreign = makeRequest("WPB-7");
    const { tracker, run, ofType } = setup({
      requests: [makeRequest("DS-6")],
      shareWithModel: true,
      repo: { listByConversation: vi.fn(async () => [foreign, makeRequest("DS-6")]) },
    });
    await run("Any news on my ticket?");
    expect(ofType("support_request").map((r) => r.id)).toEqual(["DS-6"]);
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(tracker.getIssue).toHaveBeenCalledWith("DS-6");
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

const NO_CHANGE = "I haven't changed anything with the service desk.";
const commandLines = {
  support: "To raise it, send `@Wire Team Bot support: <problem>`.",
  reply: "To send a reply, use `@Wire Team Bot reply to DS-6: <text>`.",
  resolve: "To resolve it, use `@Wire Team Bot resolve DS-6`.",
  generic: "Mention me with the command if you'd like me to act.",
} as const;
const noChange = (line: keyof typeof commandLines): string => `${NO_CHANGE}\n${commandLines[line]}`;

describe("AnswerQuestion with Jira: offers", () => {
  const support = 'OFFER: {"kind":"support","summary":"VPN  drops\\nevery ten minutes","description":"My VPN drops every ten minutes since Monday."}';
  const reply = 'OFFER: {"kind":"reply","issueKey":"DS-6","body":"Alice here: it still drops.\\nThanks"}';
  const resolve = 'OFFER: {"kind":"resolve","issueKey":"DS-6"}';
  const supportQuestion = "Shall I report this to the service desk?\n> **VPN drops every ten minutes**\n> My VPN drops every ten minutes since Monday.\n\n(yes or no)?";
  const replyQuestion = 'Shall I add this to **DS-6** "VPN drops every ten minutes"?\n> Alice here: it still drops.\n> Thanks\n\n(yes or no)?';
  const resolveQuestion = 'Shall I resolve **DS-6** "VPN drops every ten minutes" with the service desk (yes or no)?';
  const vpn = (): SupportRequest => makeRequest("DS-6", { summary: "VPN drops  every\nten minutes", statusCategory: "in_progress" });

  it("stores a valid support offer with requester and ten-minute expiry, and asks the code-written question", async () => {
    const { stored, sent, repo, run } = setup({ modelAnswer: `I can raise that.\n${support}` });
    const answer = await run("My VPN drops every ten minutes, can you raise it with the service desk?");
    expect(stored).toEqual([{
      command: { kind: "support", requestKind: "fault", summary: "VPN drops every ten minutes", description: "My VPN drops every ten minutes since Monday." },
      conversationId: convId,
      requesterId: { id: "user-1", domain: "wire.com" },
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + OFFER_TTL_MS),
    }]);
    expect(sent).toEqual([supportQuestion]);
    expect(answer).toBe(supportQuestion);
    expect(repo.findByKey).not.toHaveBeenCalled();
  });

  it("quotes a multi-line description line by line with no empty quoted line", async () => {
    const marker = `OFFER: ${JSON.stringify({ kind: "support", summary: "Printer jammed", description: "The printer is jammed.\n\n  It shows error E4.  \n" })}`;
    const { sent, run } = setup({ modelAnswer: marker });
    await run("Please raise it with the service desk");
    expect(sent).toEqual(["Shall I report this to the service desk?\n> **Printer jammed**\n> The printer is jammed.\n> It shows error E4.\n\n(yes or no)?"]);
  });

  it("leaves out a description that only repeats the summary", async () => {
    const marker = `OFFER: ${JSON.stringify({ kind: "support", summary: "Printer jammed", description: "printer  jammed" })}`;
    const { sent, run } = setup({ modelAnswer: marker });
    await run("Please raise it with the service desk");
    expect(sent).toEqual(["Shall I report this to the service desk?\n> **Printer jammed**\n\n(yes or no)?"]);
  });

  it("writes the reply question with the stored summary and the body quoted line by line, and keeps the requester's name (decision 1)", async () => {
    const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: `Here is the reply.\n${reply}` });
    await run("Tell the service desk on DS-6 that it still drops");
    expect(stored[0]!.command).toEqual({ kind: "reply", issueKey: "DS-6", body: "Alice here: it still drops.\nThanks" });
    expect(sent).toEqual([replyQuestion]);
    expect(sent[0]).toBe(formatReplyQuestion("DS-6", "VPN drops  every\nten minutes", "Alice here: it still drops.\nThanks"));
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
    await run("Raise my VPN problem with support");
    expect(wire.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan((offers.put as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it("stores no offer when sending the question fails", async () => {
    const { stored, offers, run } = setup({ modelAnswer: support, sendFails: true });
    await expect(run("Raise my VPN problem with support")).rejects.toThrow("send failed");
    expect(stored).toHaveLength(0);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it("sends an offer question without mentions, even when the quoted text names a member", async () => {
    const bob = { id: "user-2", domain: "wire.com", name: "Bob" };
    const withMention = 'OFFER: {"kind":"reply","issueKey":"DS-6","body":"@Bob will test it."}';
    const { wire, stored, run } = setup({ requests: [vpn()], modelAnswer: withMention });
    await run("Reply to DS-6 that Bob will test it", { members: [requester, bob] });
    expect(stored).toHaveLength(1);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, 'Shall I add this to **DS-6** "VPN drops every ten minutes"?\n> @Bob will test it.\n\n(yes or no)?', {
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
      ["support", "Can you raise my VPN problem with support?"],
      ["support", "My VPN drops, can you raise it with the service desk?"],
      ["support", "Please open a ticket with support"],
      ["support", "Escalate this to the service desk please"],
      ["support", "Open a support request for the printer"],
      ["support", "Please report this to the service desk"],
      ["support", "Create a Jira ticket for the printer"],
      ["support", "Can you log a request for a new laptop?"],
      ["support", "Put this into Jira"],
      ["support", "Order brake pads for truck 17"],
      ["support", "Can you order it?"],
      ["support", "Please reorder the filter we got last month"],
      ["support", "Raise it"],
      ["support", "The printer is jammed again, report it"],
      ["resolve", "Please close my request"],
      ["resolve", "Resolve DS-6"],
      ["resolve", "The VPN works again"],
      ["resolve", "It's working again, close it"],
      ["resolve", "That request is no longer needed"],
      ["reply", "Let the service desk know it still drops"],
      ["reply", "Message DS-6 that it still drops"],
      ["reply", "Answer the ticket"],
      ["reply", "Send a reply in Jira"],
      ["reply", "Tell support it still drops"],
      ["reply", "Add to DS-6 that it's the 2nd floor too"],
      ["reply", "Add a comment on DS-6"],
      ["reply", "Note on DS-6 that it still drops"],
      ["reply", "Comment on the ticket that it still drops"],
      ["reply", "Please update DS-6 with the new floor"],
      ["reply", "Update the ticket: it's the 2nd floor too"],
      ["reply", "Leave a note on DS-6 that it still drops"],
      ["reply", "Post a comment on DS-6: it still drops"],
      ["reply", "Can you add a comment on DS-6 that it started on Monday?"],
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
      ["support", "Any news on my ticket?"],
      ["support", "What's the status of my support request?"],
      ["support", "Has support replied?"],
      ["support", "Is my ticket still open?"],
      ["support", "I can't log in to Jira"],
      ["support", "Can you raise my VPN problem?"],
      ["resolve", "It's fixed now"],
      ["resolve", "What did we decide about lunch?"],
      ["resolve", "Is the VPN request done?"],
      ["resolve", "When will DS-6 be finished?"],
      ["reply", "What did we decide about lunch?"],
      ["reply", "Send me the summary of the VPN issue"],
      ["reply", "What is the service desk working on?"],
      ["reply", "Update me on DS-6"],
      ["reply", "Any update on DS-6?"],
      ["reply", "Can I get an update on the ticket?"],
      ["reply", "Is there a new note on DS-6?"],
      ["reply", "Add me to the lunch list"],
      ["support", "Sort them in order of priority"],
      ["support", "What order should we do this in?"],
      ["support", "Please order the list by due date"],
      ["reply", "Did anyone update DS-6?"],
      ["reply", "When will support update DS-6?"],
      ["reply", "Who can update the ticket?"],
      ["reply", "What did the desk note on DS-6?"],
      ["reply", "Did support add a comment on DS-6?"],
      ["reply", "Note: DS-6 is still open, right?"],
      ["reply", "Can you add me to the support channel?"],
    ];
    for (const [kind, question] of rejected) {
      it(`drops a ${kind} offer for "${question}", sends the no-change reply and logs only the kind`, async () => {
        const { stored, sent, logger, repo, run } = setup({ requests: [vpn()], modelAnswer: `Here you are.\n${markers[kind]}` });
        await run(question);
        expect(stored).toHaveLength(0);
        expect(sent).toEqual([noChange(kind)]);
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
      expect(sent).toEqual([noChange("reply")]);
      expect(tracker.getIssue).not.toHaveBeenCalled();
      expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    });
  });

  const replyAsk = "Please reply to the service desk";
  const resolveAsk = "Please resolve it";
  const replyPlaceholder = `${NO_CHANGE}\nTo send a reply, use \`@Wire Team Bot reply to DS-N: <text>\`.`;
  const resolvePlaceholder = `${NO_CHANGE}\nTo resolve it, use \`@Wire Team Bot resolve DS-N\`.`;
  const invalid: Array<[string, SupportRequest[], string, string, string]> = [
    ["reply: unknown key", [], reply, replyAsk, noChange("reply")],
    ["reply: request from another conversation", [makeRequest("DS-6", { conversationId: otherConv })], reply, replyAsk, noChange("reply")],
    ["reply: request from another domain", [makeRequest("DS-6", { conversationId: otherDomain })], reply, replyAsk, noChange("reply")],
    ["reply: deleted request", [makeRequest("DS-6", { deleted: true })], reply, replyAsk, noChange("reply")],
    ["reply: out-of-project key", [makeRequest("WPB-6")], 'OFFER: {"kind":"reply","issueKey":"WPB-6","body":"Hello"}', replyAsk, replyPlaceholder],
    ["resolve: unknown key", [], resolve, resolveAsk, noChange("resolve")],
    ["resolve: request from another conversation", [makeRequest("DS-6", { conversationId: otherConv })], resolve, resolveAsk, noChange("resolve")],
    ["resolve: request from another domain", [makeRequest("DS-6", { conversationId: otherDomain })], resolve, resolveAsk, noChange("resolve")],
    ["resolve: deleted request", [makeRequest("DS-6", { deleted: true })], resolve, resolveAsk, noChange("resolve")],
    ["resolve: out-of-project key", [makeRequest("WPB-6")], 'OFFER: {"kind":"resolve","issueKey":"WPB-6"}', resolveAsk, resolvePlaceholder],
  ];

  for (const [name, requests, marker, question, expected] of invalid) {
    it(`drops an invalid offer (${name}), never sends the marker or the model's text`, async () => {
      const { stored, sent, logger, run } = setup({ requests, modelAnswer: `Here you are.\n${marker}` });
      await run(question);
      expect(stored).toHaveLength(0);
      expect(sent).toEqual([expected]);
      expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped", { kind: expect.any(String) });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/DS-6|WPB-6|Alice here|Hello/);
    });
  }

  it("keeps a resolve offer for a request last known as done, since the use case checks live", async () => {
    const { stored, sent, run } = setup({ requests: [makeRequest("DS-6", { statusCategory: "done" })], modelAnswer: resolve });
    await run(resolveAsk);
    expect(stored).toHaveLength(1);
    expect(sent).toEqual(['Shall I resolve **DS-6** "Problem DS-6" with the service desk (yes or no)?']);
  });

  it("allows a reply to a done request", async () => {
    const { stored, run } = setup({ requests: [makeRequest("DS-6", { statusCategory: "done" })], modelAnswer: reply });
    await run(replyAsk);
    expect(stored).toHaveLength(1);
  });

  it("drops an offer that fails bounds in the parser, and sends the generic no-change reply", async () => {
    const long = `OFFER: ${JSON.stringify({ kind: "support", summary: "s".repeat(121), description: "It breaks." })}`;
    const { stored, sent, run } = setup({ modelAnswer: `Here you are.\n${long}` });
    await run("Raise this with the service desk");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual([noChange("generic")]);
  });

  it("rejects the old raise and close kinds", async () => {
    for (const marker of ['OFFER: {"kind":"raise","actionId":"ACT-0010"}', 'OFFER: {"kind":"close","actionId":"ACT-0010"}']) {
      const { stored, sent, run } = setup({ modelAnswer: `Here you are.\n${marker}` });
      await run("Raise it in Jira and close it");
      expect(stored).toHaveLength(0);
      expect(sent).toEqual([noChange("generic")]);
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
      expect(sent).toEqual([noChange(kind)]);
      expect(repo.findByKey.mock.calls.map((call) => call[0])).not.toContain("DS-6");
    });

    it(`drops a ${kind} offer when the requester has no domain`, async () => {
      const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: `Here you are.\n${marker}` });
      await run(question, { requester: { id: "user-1", name: "Alice" } });
      expect(stored).toHaveLength(0);
      expect(sent).toEqual([noChange(kind)]);
    });
  }

  it("drops the offer when the record lookup fails", async () => {
    const { stored, sent, logger, run } = setup({ modelAnswer: `Here you are.\n${resolve}`, repo: { findByKey: vi.fn(async () => { throw new Error("db down"); }) } });
    await run(resolveAsk);
    expect(stored).toHaveLength(0);
    expect(sent).toEqual([noChange("resolve")]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer validation failed", { kind: "resolve", err: "Error" });
  });

  it("sends the generic no-change reply for a malformed marker and marker lines that are not last", async () => {
    const { stored, sent, run } = setup({ modelAnswer: `${support}\nThe answer.\nOFFER: {not json` });
    await run("Raise it with the service desk");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual([noChange("generic")]);
  });

  it("sends the generic no-change reply for an unknown kind, never the model's claim", async () => {
    const { stored, sent, run } = setup({ modelAnswer: 'Updated with that detail.\nOFFER: {"kind":"amend","issueKey":"DS-6"}' });
    await run("Raise it with the service desk");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual([noChange("generic")]);
  });

  it("sends the no-change reply when the model wrote nothing but a dropped marker", async () => {
    const { sent, run } = setup({ modelAnswer: 'OFFER: {"kind":"resolve","issueKey":"DS-6"}' });
    await run("Resolve DS-6");
    expect(sent).toEqual([noChange("resolve")]);
  });

  it("sends the no-change reply without mentions", async () => {
    const { wire, run } = setup({ modelAnswer: "@Alice I've sent it.\nOFFER: stray" });
    await run("Who owns the proposal?");
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, noChange("generic"), { replyToMessageId: "q", mentions: undefined });
  });

  it("sends the fallback when the model wrote nothing", async () => {
    const { sent, run } = setup({ modelAnswer: "   " });
    await run("Resolve DS-6");
    expect(sent).toEqual(["I wasn't able to generate a response."]);
  });

  it("sends only the question when the model wrote nothing but the marker", async () => {
    const { sent, run } = setup({ modelAnswer: support });
    await run("Raise my VPN problem with support");
    expect(sent).toEqual([supportQuestion]);
  });

  it("creates offers whether or not ticket sharing is on", async () => {
    for (const shareWithModel of [false, true]) {
      const { stored, tracker, run } = setup({ modelAnswer: support, shareWithModel });
      await run("Raise my VPN problem with support");
      expect(stored).toHaveLength(1);
      expect(tracker.createIssue).not.toHaveBeenCalled();
    }
  });

  it("extracts mentions from the final text", async () => {
    const { wire, run } = setup({ modelAnswer: "@Alice owns it." });
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

describe("AnswerQuestion with Jira: passive service-desk help on", () => {
  const support = `OFFER: ${JSON.stringify({ kind: "support", summary: "Printer on floor 2 is out of toner", description: "The printer on floor 2 is out of toner." })}`;

  it("accepts a support offer for a plain problem statement, since the operator opted in", async () => {
    const { stored, sent, run } = setup({ passive: true, modelAnswer: support });
    await run("the printer on floor 2 is out of toner");
    expect(sent).toEqual(["Shall I report this to the service desk?\n> **Printer on floor 2 is out of toner**\n> The printer on floor 2 is out of toner.\n\n(yes or no)?"]);
    expect(stored).toHaveLength(1);
  });

  it("still needs raising wording for a support offer when passive help is off", async () => {
    const { stored, sent, run } = setup({ modelAnswer: support });
    await run("the printer on floor 2 is out of toner");
    expect(stored).toHaveLength(0);
    expect(sent[0]).toContain("I haven't changed anything with the service desk.");
  });

  it("keeps the change-intent check for reply and resolve offers when passive help is on", async () => {
    const { stored, run } = setup({ passive: true, requests: [makeRequest("DS-6")], modelAnswer: `OFFER: {"kind":"resolve","issueKey":"DS-6"}` });
    await run("the printer on floor 2 is out of toner");
    expect(stored).toHaveLength(0);
  });
});

describe("AnswerQuestion with Jira: amending a pending offer", () => {
  const original: OfferCommand = { kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops every ten minutes." };
  const pendingReply: OfferCommand = { kind: "reply", issueKey: "DS-6", body: "It still drops." };
  const revisedSupport = `OFFER: ${JSON.stringify({ kind: "support", summary: "VPN drops", description: "My VPN drops every ten minutes since Monday." })}`;
  const revisedReply = `OFFER: ${JSON.stringify({ kind: "reply", issueKey: "DS-6", body: "It still drops after a reboot." })}`;
  const vpn = (): SupportRequest => makeRequest("DS-6", { summary: "VPN drops" });
  const pendingResults = (passed: RetrievalResult[]): RetrievalResult[] => passed.filter((r) => r.pathsMatched.includes("pending_offer"));

  it.each([original, pendingReply])("passes a pending %j offer to the model as a related result", async (pendingOffer) => {
    const { run, passedResults } = setup({ requests: [vpn()], modelAnswer: "Noted." });
    await run("It started on Monday", { pendingOffer });
    expect(pendingResults(passedResults())).toEqual([{
      id: "pending-offer",
      type: "summary",
      content: `Pending offer being amended (not confirmed, nothing was sent; the requester's message changes it): ${JSON.stringify(pendingOffer)}`,
      sourceChannel: "conv-1@wire.com",
      sourceDate: NOW,
      confidence: 1,
      pathsMatched: ["pending_offer"],
    }]);
  });

  it("does not pass a pending resolve offer or an absent one", async () => {
    for (const pendingOffer of [{ kind: "resolve", issueKey: "DS-6" } as const, undefined]) {
      const { run, passedResults } = setup({ requests: [vpn()], modelAnswer: "Noted." });
      await run("It started on Monday", { pendingOffer });
      expect(pendingResults(passedResults())).toEqual([]);
    }
  });

  it("accepts a revised support offer without change intent, shows it in full and stores it", async () => {
    const { stored, sent, run } = setup({ modelAnswer: `Updated.\n${revisedSupport}` });
    await run("The description should mention it started on Monday", { pendingOffer: original });
    const question = "Shall I report this to the service desk?\n> **VPN drops**\n> My VPN drops every ten minutes since Monday.\n\n(yes or no)?";
    expect(sent).toEqual([question]);
    expect(stored.map((o) => o.command)).toEqual([{ kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops every ten minutes since Monday." }]);
  });

  it("sends nothing for unaddressed chat after an offer that does not revise it", async () => {
    const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: "Lunch is at noon." });
    const answer = await run("Bob, lunch at noon?", { pendingOffer: original, amendOnly: true });
    expect(answer).toBe("");
    expect(sent).toEqual([]);
    expect(stored).toHaveLength(0);
  });

  it("sends nothing when unaddressed chat only repeats the same offer, so it does not follow every message", async () => {
    const same = `OFFER: ${JSON.stringify(original)}`;
    const { stored, sent, run } = setup({ modelAnswer: `Here it is again.\n${same}` });
    expect(await run("never mind, I'll check later", { pendingOffer: original, amendOnly: true })).toBe("");
    expect(sent).toEqual([]);
    expect(stored).toHaveLength(0);
  });

  it("sends a real revision for an unaddressed correction", async () => {
    const { stored, sent, run } = setup({ modelAnswer: revisedSupport });
    await run("it started on Monday", { pendingOffer: original, amendOnly: true });
    expect(sent).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });

  it("accepts a revised reply on the same request without change intent", async () => {
    const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: revisedReply });
    await run("Also mention that I rebooted", { pendingOffer: pendingReply });
    expect(sent).toEqual(['Shall I add this to **DS-6** "VPN drops"?\n> It still drops after a reboot.\n\n(yes or no)?']);
    expect(stored).toHaveLength(1);
  });

  it("applies the change-intent check to a reply revision for another request", async () => {
    const other = `OFFER: ${JSON.stringify({ kind: "reply", issueKey: "DS-7", body: "It still drops." })}`;
    const { stored, sent, logger, run } = setup({ requests: [vpn(), makeRequest("DS-7")], modelAnswer: `Done.\n${other}` });
    await run("Also mention that I rebooted", { pendingOffer: pendingReply });
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["I haven't changed anything with the service desk.\nTo send a reply, use `@Wire Team Bot reply to DS-7: <text>`."]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped, the question asks for no change", { kind: "reply" });
  });

  it("applies the change-intent check to an offer of a different kind", async () => {
    const { stored, sent, run } = setup({ requests: [vpn()], modelAnswer: `Resolved.\nOFFER: {"kind":"resolve","issueKey":"DS-6"}` });
    await run("It started on Monday", { pendingOffer: original });
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["I haven't changed anything with the service desk.\nTo resolve it, use `@Wire Team Bot resolve DS-6`."]);
  });

  it("does not exempt a revision of a pending resolve offer", async () => {
    const { stored, run } = setup({ requests: [vpn()], modelAnswer: 'OFFER: {"kind":"resolve","issueKey":"DS-6"}' });
    await run("It started on Monday", { pendingOffer: { kind: "resolve", issueKey: "DS-6" } });
    expect(stored).toHaveLength(0);
  });

  it("still validates a revision's scope, bounds and requester", async () => {
    const outOfScope = setup({ requests: [makeRequest("DS-6", { conversationId: otherConv })], modelAnswer: revisedReply });
    await outOfScope.run("Also mention that I rebooted", { pendingOffer: pendingReply });
    expect(outOfScope.stored).toHaveLength(0);
    expect(outOfScope.sent).toEqual(["I haven't changed anything with the service desk.\nTo send a reply, use `@Wire Team Bot reply to DS-6: <text>`."]);

    const tooLong = `OFFER: ${JSON.stringify({ kind: "support", summary: "s".repeat(121), description: "It breaks." })}`;
    const bounds = setup({ modelAnswer: tooLong });
    await bounds.run("Make the summary longer", { pendingOffer: original });
    expect(bounds.stored).toHaveLength(0);
    expect(bounds.sent).toEqual(["I haven't changed anything with the service desk.\nMention me with the command if you'd like me to act."]);

    const noDomain = setup({ modelAnswer: revisedSupport });
    await noDomain.run("It started on Monday", { pendingOffer: original, requester: { id: "user-1", name: "Alice" } });
    expect(noDomain.stored).toHaveLength(0);
    expect(noDomain.sent).toEqual(["I haven't changed anything with the service desk.\nTo raise it, send `@Wire Team Bot support: <problem>`."]);
  });

  it("sends the answer as today when the model returns no offer", async () => {
    const { stored, sent, run } = setup({ modelAnswer: "Which detail should I add?" });
    await run("Change it", { pendingOffer: original });
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["Which detail should I add?"]);
  });
});

describe("AnswerQuestion with Jira: request kinds and part orders", () => {
  const offer = (fields: Record<string, unknown>): string =>
    `OFFER: ${JSON.stringify({ kind: "support", summary: "Brake pads for truck 17", description: "Front pads are worn down.", ...fields })}`;
  const PART = { vehicle: "Truck 17", part: "Brake pads, front", quantity: "2", deliverTo: "Depot North" };
  const partQuestion = "Shall I order this part?\n> **Brake pads for truck 17**\n> Vehicle: Truck 17\n> Part: Brake pads, front\n> Quantity: 2\n> Deliver to: Depot North\n> Front pads are worn down.\n\n(yes or no)?";
  const incomplete: OfferCommand = {
    kind: "support", requestKind: "part", summary: "Brake pads for truck 17", description: "Front pads are worn down.",
    part: { part: "Brake pads, front", quantity: "2" },
  };

  it.each([
    ["question", "Shall I ask the service desk?"],
    ["fault", "Shall I report this to the service desk?"],
  ])("asks the %s question for that kind", async (requestKind, lead) => {
    const { stored, sent, run } = setup({ modelAnswer: offer({ requestKind }) });
    await run("Please raise it with the service desk");
    expect(sent).toEqual([`${lead}\n> **Brake pads for truck 17**\n> Front pads are worn down.\n\n(yes or no)?`]);
    expect(stored[0]!.command).toMatchObject({ kind: "support", requestKind });
  });

  it("shows a complete part order with its details above the description and stores it", async () => {
    const { stored, sent, run } = setup({ modelAnswer: offer({ requestKind: "part", part: PART }) });
    await run("Please order two front brake pads for truck 17, deliver to Depot North");
    expect(sent).toEqual([partQuestion]);
    expect(stored.map((o) => o.command)).toEqual([{
      kind: "support", requestKind: "part", summary: "Brake pads for truck 17", description: "Front pads are worn down.", part: PART,
    }]);
  });

  it("asks for the missing details of an incomplete part order and stores it as an amendable draft", async () => {
    const { stored, sent, run } = setup({ modelAnswer: `Happy to.\n${offer({ requestKind: "part", part: { part: "Brake pads, front", quantity: "2" } })}` });
    const answer = await run("Can you order two front brake pads?");
    const question = "To order it I need the vehicle (fleet or chassis number) and the delivery location. What are they?";
    expect(sent).toEqual([question]);
    expect(answer).toBe(question);
    expect(stored.map((o) => o.command)).toEqual([incomplete]);
  });

  it("asks for every essential when a part order has none", async () => {
    const { sent, run } = setup({ modelAnswer: offer({ requestKind: "part" }) });
    await run("Please order a replacement mirror");
    expect(sent).toEqual([
      "To order it I need the vehicle (fleet or chassis number), the part (name or number), the quantity and the delivery location. What are they?",
    ]);
  });

  it("treats the driver's answer that fills the details as a revision, even unaddressed, and then offers the order", async () => {
    const { stored, sent, run } = setup({ modelAnswer: offer({ requestKind: "part", part: PART }) });
    await run("truck 17, to Depot North", { pendingOffer: incomplete, amendOnly: true });
    expect(sent).toEqual([partQuestion]);
    expect(stored[0]!.command).toMatchObject({ requestKind: "part", part: PART });
  });

  it("keeps the details already given when the model returns only the new ones", async () => {
    const { stored, sent, run } = setup({ modelAnswer: offer({ requestKind: "part", part: { vehicle: "Truck 17", deliverTo: "Depot North" } }) });
    await run("truck 17, to Depot North", { pendingOffer: incomplete, amendOnly: true });
    expect(sent).toEqual([partQuestion]);
    expect(stored[0]!.command).toMatchObject({ part: { part: "Brake pads, front", quantity: "2", vehicle: "Truck 17", deliverTo: "Depot North" } });
  });

  it("does not accept a switch from a part order to a fault as a revision of the draft", async () => {
    const { stored, sent, run } = setup({ modelAnswer: offer({ requestKind: "fault" }) });
    expect(await run("just report it", { pendingOffer: incomplete, amendOnly: true })).toBe("");
    expect(sent).toEqual([]);
    expect(stored).toHaveLength(0);
  });

  it("asks again for what is still missing after a partial answer", async () => {
    const { stored, sent, run } = setup({ modelAnswer: offer({ requestKind: "part", part: { part: "Brake pads, front", quantity: "2", vehicle: "Truck 17" } }) });
    await run("it's truck 17", { pendingOffer: incomplete, amendOnly: true });
    expect(sent).toEqual(["To order it I need the delivery location. What is it?"]);
    expect(stored).toHaveLength(1);
  });

  it.each([
    "Please order two brake pads for truck 17",
    "Can you order a replacement mirror?",
    "order me the oil filter",
    "Ask the service desk how often the oil is changed",
  ])("accepts %j as asking for a support offer", async (question) => {
    const { stored, run } = setup({ modelAnswer: offer({ requestKind: "part", part: PART }) });
    await run(question);
    expect(stored).toHaveLength(1);
  });

  it.each([
    "What order should we do the checks in?",
    "I came in order to fix the mirror",
    "The order of the steps is wrong",
  ])("does not accept %j as asking for a support offer", async (question) => {
    const { stored, run } = setup({ modelAnswer: offer({ requestKind: "part", part: PART }) });
    await run(question);
    expect(stored).toHaveLength(0);
  });

  it("shows the kind of each stored request to the model", async () => {
    const requests = [
      makeRequest("DS-12", { kind: "part" }),
      makeRequest("DS-11", { kind: "question" }),
      makeRequest("DS-10", { kind: "fault", requesterName: "" }),
    ];
    const { ofType, run } = setup({ requests });
    await run("Which requests are open?");
    expect(ofType("support_request").map((r) => r.content)).toEqual([
      "DS-12 | Summary: Problem DS-12 | Kind: part order | Requested by: Alice | Last known status: To do",
      "DS-11 | Summary: Problem DS-11 | Kind: question | Requested by: Alice | Last known status: To do",
      "DS-10 | Summary: Problem DS-10 | Kind: fault | Last known status: To do",
    ]);
  });
});
