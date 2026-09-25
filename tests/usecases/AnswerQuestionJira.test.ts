import { describe, it, expect, vi } from "vitest";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";
import type { AnswerQuestionInput } from "../../src/application/usecases/general/AnswerQuestion";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueTrackerPort } from "../../src/application/ports/IssueTrackerPort";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import { OFFER_TTL_MS } from "../../src/application/services/offers";
import type { PendingOffer, PendingOfferStore } from "../../src/application/services/offers";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const requester = { id: "user-1", domain: "wire.com", name: "Alice" };
const NOW = new Date("2026-09-25T10:00:00Z");

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0010",
    description: "Write the customer proposal",
    rawMessageId: "",
    assigneeId: { id: "user-2", domain: "wire.com" },
    assigneeName: "Bob",
    creatorId: { id: "user-1", domain: "wire.com" },
    authorName: "Alice",
    conversationId: convId,
    deadline: null,
    status: "open",
    linkedIds: [],
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

function snapshotFor(key: string): IssueSnapshot {
  return {
    key,
    url: `https://jira.test/browse/${key}`,
    summary: `Summary of ${key}`,
    statusCategory: "in_progress",
    slas: [{ name: "Time to done", state: "running", remaining: "15h", goal: "16h" }],
  };
}

function actionResult(id: string): RetrievalResult {
  return { id, type: "action", content: `${id} | something`, sourceChannel: "conv-1@wire.com", sourceDate: NOW, confidence: 0.9, pathsMatched: ["structured"] };
}

interface SetupOptions {
  actions?: Action[];
  results?: RetrievalResult[];
  modelAnswer?: string;
  shareWithModel?: boolean;
  withJira?: boolean;
  tracker?: Partial<IssueTrackerPort>;
}

function setup(options: SetupOptions = {}) {
  const all = options.actions ?? [];
  const repo = {
    findById: vi.fn(async (id: string) => all.find((a) => a.id === id) ?? null),
    query: vi.fn(async (criteria: { linkedIdsHas?: string }) =>
      all.filter((a) => !criteria.linkedIdsHas || a.linkedIds.includes(criteria.linkedIdsHas))),
    update: vi.fn(),
    create: vi.fn(),
    nextId: vi.fn(),
  } satisfies ActionRepository;
  const tracker = {
    projectKey: "DS",
    createIssue: vi.fn(),
    getIssue: vi.fn(async (key: string) => snapshotFor(key)),
    resolveIssue: vi.fn(),
    listCustomerReplies: vi.fn(async (): Promise<IssueReply[]> => []),
    addCustomerReply: vi.fn(),
    ...options.tracker,
  } satisfies IssueTrackerPort;
  const stored: PendingOffer[] = [];
  const offers: PendingOfferStore = {
    put: vi.fn((offer: PendingOffer) => { stored.push(offer); }),
    take: vi.fn(() => null),
    has: vi.fn(() => false),
    clearConversation: vi.fn(),
  };
  const general = { answer: vi.fn().mockResolvedValue(options.modelAnswer ?? "Here is the answer.") };
  const sent: string[] = [];
  const wire = { sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => { sent.push(text); }) };
  const analysis = { analyse: vi.fn().mockResolvedValue({ complexity: 0.5 }) };
  const retrieval = { retrieve: vi.fn().mockResolvedValue(options.results ?? []) };
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  const jira = options.withJira === false
    ? undefined
    : { tracker, actions: repo, offers, shareWithModel: options.shareWithModel ?? false, now: () => NOW };
  const useCase = new AnswerQuestion(general, wire as never, analysis, retrieval, logger, jira);
  const run = (question: string, overrides: Partial<AnswerQuestionInput> = {}) => useCase.execute({
    question, conversationContext: [], conversationId: convId, replyToMessageId: "q", requester,
    members: [requester], channelId: "conv-1@wire.com", orgId: "wire.com", ...overrides,
  });
  const passedResults = (): RetrievalResult[] => general.answer.mock.calls[0]![2] as RetrievalResult[];
  return { repo, tracker, offers, stored, general, wire, sent, logger, run, passedResults };
}

describe("AnswerQuestion with Jira: live ticket data", () => {
  it("makes no tracker call and adds no ticket results when sharing is off", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const { tracker, run, passedResults } = setup({ actions: [linked], results: [actionResult("ACT-0010")], shareWithModel: false });
    await run("What's the latest on DS-4?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(passedResults().some((r) => r.type === "jira_ticket")).toBe(false);
  });

  it("makes no tracker call when Jira support is absent", async () => {
    const { tracker, run, passedResults } = setup({ withJira: false, results: [actionResult("ACT-0010")] });
    await run("What's the latest on DS-4?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(passedResults()).toEqual([actionResult("ACT-0010")]);
  });

  it("adds a compact ticket result for a retrieved linked action", async () => {
    const linked = makeAction({ linkedIds: ["DEC-0001", "jira:DS-4"] });
    const replies: IssueReply[] = [
      { author: "Service Desk Agent", created: new Date("2026-09-24T09:00:00Z"), body: "We are  looking\ninto it." },
      { author: "WireTeamBotDemo", created: new Date("2026-09-24T10:00:00Z"), body: "Thanks.", fromThisBot: true },
    ];
    const { tracker, run, passedResults } = setup({
      actions: [linked], results: [actionResult("ACT-0010")], shareWithModel: true,
      tracker: { listCustomerReplies: vi.fn(async () => replies) },
    });
    await run("What's the latest on the proposal?");
    expect(tracker.listCustomerReplies).toHaveBeenCalledWith("DS-4", 3);
    const tickets = passedResults().filter((r) => r.type === "jira_ticket");
    expect(tickets).toEqual([{
      id: "DS-4", type: "jira_ticket", sourceChannel: "conv-1@wire.com", sourceDate: NOW, confidence: 1, pathsMatched: ["jira"],
      content: [
        "DS-4: Summary of DS-4",
        "Status: In progress",
        "Time to done: running, 15h left of 16h",
        "Linked action: ACT-0010",
        "Reply from Service Desk Agent at 2026-09-24T09:00:00.000Z: We are looking into it.",
        "Reply from your team via Wire at 2026-09-24T10:00:00.000Z: Thanks.",
      ].join("\n"),
    }]);
    expect(passedResults()[0]).toEqual(actionResult("ACT-0010"));
  });

  it("uses the category label, never the tracker's status name, and truncates long replies", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const localised = { ...snapshotFor("DS-4"), statusCategory: "done" as const, statusName: "Erledigt" };
    const { run, passedResults } = setup({
      actions: [linked], results: [actionResult("ACT-0010")], shareWithModel: true,
      tracker: {
        getIssue: vi.fn(async () => localised),
        listCustomerReplies: vi.fn(async () => [{ author: "Agent", created: NOW, body: "x".repeat(600) }]),
      },
    });
    await run("Is the proposal done?");
    const content = passedResults().find((r) => r.type === "jira_ticket")!.content;
    expect(content).toContain("Status: Done");
    expect(content).not.toContain("Erledigt");
    expect(content).toContain(`: ${"x".repeat(497)}...`);
    expect(content).not.toContain("x".repeat(498));
  });

  it("adds tickets named in the question only when linked from this conversation", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const elsewhere = makeAction({ id: "ACT-0020", linkedIds: ["jira:DS-5"], conversationId: { id: "conv-2", domain: "wire.com" } });
    const deleted = makeAction({ id: "ACT-0030", linkedIds: ["jira:DS-6"], deleted: true });
    const { tracker, run, passedResults } = setup({ actions: [linked, elsewhere, deleted], shareWithModel: true });
    await run("How are ds-4, DS-5, DS-6, DS-7 and WPB-1 doing?");
    expect(passedResults().map((r) => r.id)).toEqual(["DS-4"]);
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(passedResults()[0]!.content).toContain("Linked action: ACT-0010");
  });

  it("skips retrieved actions that are cross-conversation, other-domain, deleted, unlinked or out of project", async () => {
    const actions = [
      makeAction({ id: "ACT-0001", linkedIds: ["jira:DS-1"], conversationId: { id: "conv-2", domain: "wire.com" } }),
      makeAction({ id: "ACT-0002", linkedIds: ["jira:DS-2"], conversationId: { id: "conv-1", domain: "other.com" } }),
      makeAction({ id: "ACT-0003", linkedIds: ["jira:DS-3"], deleted: true }),
      makeAction({ id: "ACT-0004", linkedIds: [] }),
      makeAction({ id: "ACT-0005", linkedIds: ["jira:WPB-5"] }),
    ];
    const { tracker, run, passedResults } = setup({
      actions, results: actions.map((a) => actionResult(a.id)), shareWithModel: true,
    });
    await run("What's the status of everything?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(passedResults().some((r) => r.type === "jira_ticket")).toBe(false);
  });

  it("caps shared tickets at three and inspects at most five action results", async () => {
    const actions = [1, 2, 3, 4, 5, 6].map((n) => makeAction({ id: `ACT-000${n}`, linkedIds: [`jira:DS-${n}`] }));
    const { repo, tracker, run, passedResults } = setup({
      actions, results: actions.map((a) => actionResult(a.id)), shareWithModel: true,
    });
    await run("What's happening?");
    expect(passedResults().filter((r) => r.type === "jira_ticket").map((r) => r.id)).toEqual(["DS-1", "DS-2", "DS-3"]);
    expect(tracker.getIssue).toHaveBeenCalledTimes(3);
    expect(repo.findById.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("deduplicates a ticket named in the question and linked from a retrieved action", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const { tracker, run, passedResults } = setup({ actions: [linked], results: [actionResult("ACT-0010")], shareWithModel: true });
    await run("What about DS-4?");
    expect(passedResults().filter((r) => r.type === "jira_ticket")).toHaveLength(1);
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
  });

  it("skips a ticket that fails to load and still answers with the others", async () => {
    const actions = [
      makeAction({ id: "ACT-0001", linkedIds: ["jira:DS-1"] }),
      makeAction({ id: "ACT-0002", linkedIds: ["jira:DS-2"] }),
      makeAction({ id: "ACT-0003", linkedIds: ["jira:DS-3"] }),
    ];
    const { run, passedResults, sent, logger } = setup({
      actions, results: actions.map((a) => actionResult(a.id)), shareWithModel: true,
      tracker: {
        getIssue: vi.fn(async (key: string) => {
          if (key === "DS-1") throw new IssueTrackerError("Jira request failed with secret body", 503);
          return key === "DS-3" ? null : snapshotFor(key);
        }),
      },
    });
    await run("What's happening?");
    expect(passedResults().filter((r) => r.type === "jira_ticket").map((r) => r.id)).toEqual(["DS-2"]);
    expect(sent).toEqual(["Here is the answer."]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: ticket read failed", { err: "IssueTrackerError", status: 503 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret body");
  });

  it("never logs ticket content", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const { run, logger } = setup({
      actions: [linked], results: [actionResult("ACT-0010")], shareWithModel: true,
      tracker: { listCustomerReplies: vi.fn(async () => [{ author: "Agent", created: NOW, body: "Confidential terms" }]) },
    });
    await run("Latest?");
    const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.debug.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain("Confidential");
    expect(logged).not.toContain("Summary of DS-4");
  });
});

describe("AnswerQuestion with Jira: offers", () => {
  const raise = 'OFFER: {"kind":"raise","actionId":"ACT-0010"}';
  const close = 'OFFER: {"kind":"close","actionId":"ACT-0010"}';
  const reply = 'OFFER: {"kind":"reply","issueKey":"DS-4","body":"Please send the draft.\\nThanks"}';

  it("stores a valid raise offer with requester and ten-minute expiry", async () => {
    const { stored, sent, run } = setup({ actions: [makeAction({ description: "Write the  customer\nproposal" })], modelAnswer: `ACT-0010 is not in Jira yet.\n${raise}` });
    const answer = await run("Can you put the proposal action into Jira?");
    expect(stored).toEqual([{
      command: { kind: "raise", actionId: "ACT-0010" },
      conversationId: convId,
      requesterId: { id: "user-1", domain: "wire.com" },
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + OFFER_TTL_MS),
    }]);
    const expected = 'ACT-0010 is not in Jira yet.\n\nShall I raise **ACT-0010** "Write the customer proposal" in Jira? Reply yes or no.';
    expect(sent).toEqual([expected]);
    expect(answer).toBe(expected);
  });

  it("writes the close question from the action's linked key", async () => {
    const { stored, sent, run } = setup({ actions: [makeAction({ status: "in_progress", linkedIds: ["jira:DS-4"] })], modelAnswer: close });
    await run("Mark the proposal done and close its ticket");
    expect(stored).toHaveLength(1);
    expect(sent).toEqual(["Shall I mark **ACT-0010** done and close **DS-4** in Jira? Reply yes or no."]);
  });

  it("writes the reply question with the body quoted line by line", async () => {
    const { stored, sent, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: `Here is the reply.\n${reply}` });
    await run("Tell the service desk on DS-4 to send the draft");
    expect(stored[0]!.command).toEqual({ kind: "reply", issueKey: "DS-4", body: "Please send the draft.\nThanks" });
    expect(sent).toEqual(["Here is the reply.\n\nShall I send this reply to **DS-4** in Jira?\n> Please send the draft.\n> Thanks\n\nReply yes or no."]);
  });

  it("removes a trailing model-written offer question when appending the code-written one", async () => {
    const { sent, run } = setup({ actions: [makeAction()], modelAnswer: `ACT-0010 has no ticket yet. Shall I raise it in Jira for you?\n${raise}` });
    await run("Put the proposal into Jira");
    expect(sent).toEqual(['ACT-0010 has no ticket yet.\n\nShall I raise **ACT-0010** "Write the customer proposal" in Jira? Reply yes or no.']);
  });

  it("keeps a trailing question that is not an offer", async () => {
    const { sent, run } = setup({ actions: [makeAction()], modelAnswer: `Is this the proposal action?\n${raise}` });
    await run("Put the proposal into Jira");
    expect(sent[0]).toMatch(/^Is this the proposal action\?\n\nShall I raise/);
  });

  const other = { id: "conv-2", domain: "wire.com" };
  const otherDomain = { id: "conv-1", domain: "other.com" };
  const invalid: Array<[string, Action[], string]> = [
    ["raise: missing action", [], raise],
    ["raise: deleted action", [makeAction({ deleted: true })], raise],
    ["raise: other conversation", [makeAction({ conversationId: other })], raise],
    ["raise: other domain", [makeAction({ conversationId: otherDomain })], raise],
    ["raise: done action", [makeAction({ status: "done" })], raise],
    ["raise: cancelled action", [makeAction({ status: "cancelled" })], raise],
    ["raise: already linked", [makeAction({ linkedIds: ["jira:DS-4"] })], raise],
    ["raise: linked to another project", [makeAction({ linkedIds: ["jira:WPB-4"] })], raise],
    ["close: missing action", [], close],
    ["close: deleted action", [makeAction({ deleted: true, linkedIds: ["jira:DS-4"] })], close],
    ["close: other conversation", [makeAction({ conversationId: other, linkedIds: ["jira:DS-4"] })], close],
    ["close: other domain", [makeAction({ conversationId: otherDomain, linkedIds: ["jira:DS-4"] })], close],
    ["close: done action", [makeAction({ status: "done", linkedIds: ["jira:DS-4"] })], close],
    ["close: unlinked action", [makeAction()], close],
    ["close: out-of-project link", [makeAction({ linkedIds: ["jira:WPB-4"] })], close],
    ["reply: unlinked key", [makeAction()], reply],
    ["reply: linked only from another conversation", [makeAction({ conversationId: other, linkedIds: ["jira:DS-4"] })], reply],
    ["reply: linked only from a deleted action", [makeAction({ deleted: true, linkedIds: ["jira:DS-4"] })], reply],
    ["reply: out-of-project key", [makeAction({ linkedIds: ["jira:WPB-4"] })], 'OFFER: {"kind":"reply","issueKey":"WPB-4","body":"Hello"}'],
  ];

  for (const [name, actions, marker] of invalid) {
    it(`drops an invalid offer (${name}) and never sends the marker`, async () => {
      const { stored, sent, logger, run } = setup({ actions, modelAnswer: `Here you are.\n${marker}` });
      await run("Please do it");
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Here you are."]);
      expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped", { kind: expect.any(String) });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/ACT-0010|DS-4|WPB-4|Please send|Hello/);
    });
  }

  it("drops an offer when the requester is unknown", async () => {
    const { stored, sent, repo, run } = setup({ actions: [makeAction()], modelAnswer: `Here you are.\n${raise}` });
    await run("Put it in Jira", { requester: undefined });
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["Here you are."]);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("drops an offer when the requester has no domain", async () => {
    const { stored, run } = setup({ actions: [makeAction()], modelAnswer: raise });
    await run("Put it in Jira", { requester: { id: "user-1", name: "Alice" } });
    expect(stored).toHaveLength(0);
  });

  it("strips a malformed marker and marker lines that are not last", async () => {
    const { stored, sent, run } = setup({ actions: [makeAction()], modelAnswer: `OFFER: {"kind":"raise","actionId":"ACT-0010"}\nThe answer.\nOFFER: {not json` });
    await run("Anything");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["The answer."]);
  });

  it("sends only the question when the model wrote nothing but the marker", async () => {
    const { sent, run } = setup({ actions: [makeAction()], modelAnswer: raise });
    await run("Raise the proposal");
    expect(sent).toEqual(['Shall I raise **ACT-0010** "Write the customer proposal" in Jira? Reply yes or no.']);
  });

  it("creates offers whether or not ticket sharing is on", async () => {
    const { stored, tracker, run } = setup({ actions: [makeAction()], modelAnswer: raise, shareWithModel: false });
    await run("Raise the proposal");
    expect(stored).toHaveLength(1);
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("extracts mentions from the final text", async () => {
    const { wire, run } = setup({ actions: [makeAction()], modelAnswer: `OFFER: stray\n@Alice owns it.\n${raise}` });
    const final = await run("Raise it");
    expect(final.startsWith("@Alice owns it.\n\nShall I raise")).toBe(true);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, final, {
      replyToMessageId: "q",
      mentions: [{ userId: { id: "user-1", domain: "wire.com" }, offset: 0, length: "@Alice".length }],
    });
  });

  it("sends the answer unchanged when Jira support is absent, even with a marker-like line", async () => {
    const answer = `Here you are.\n${raise}`;
    const { stored, sent, run } = setup({ withJira: false, actions: [makeAction()], modelAnswer: answer });
    await run("Raise it");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual([answer]);
  });
});
