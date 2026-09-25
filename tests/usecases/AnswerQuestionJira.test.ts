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

/** An action result as retrieval formats it, with the `Jira: <KEY>` field when linked. */
function actionResult(id: string, jiraKey?: string, content?: string): RetrievalResult {
  const fields = [`ID: ${id}`, "Action: something", "Owner: Bob", "Status: open", ...(jiraKey ? [`Jira: ${jiraKey}`] : [])];
  return { id, type: "action", content: content ?? fields.join(" | "), sourceChannel: "conv-1@wire.com", sourceDate: NOW, confidence: 0.9, pathsMatched: ["structured"] };
}

interface SetupOptions {
  actions?: Action[];
  results?: RetrievalResult[];
  modelAnswer?: string;
  shareWithModel?: boolean;
  withJira?: boolean;
  tracker?: Partial<IssueTrackerPort>;
  sendFails?: boolean;
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
    const { tracker, run, passedResults } = setup({ actions: [linked], results: [actionResult("ACT-0010", "DS-4")], shareWithModel: false });
    await run("What's the latest on DS-4?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(passedResults().some((r) => r.type === "jira_ticket")).toBe(false);
  });

  it("makes no tracker call when Jira support is absent", async () => {
    const { tracker, run, passedResults } = setup({ withJira: false, results: [actionResult("ACT-0010", "DS-4")] });
    await run("What's the latest on DS-4?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(passedResults()).toEqual([actionResult("ACT-0010", "DS-4")]);
  });

  it("adds a compact ticket result for a retrieved linked action", async () => {
    const replies: IssueReply[] = [
      { author: "Service Desk Agent", created: new Date("2026-09-24T09:00:00Z"), body: "We are  looking\ninto it." },
      { author: "WireTeamBotDemo", created: new Date("2026-09-24T10:00:00Z"), body: "Thanks.", fromThisBot: true },
    ];
    const { tracker, run, passedResults } = setup({
      results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true,
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
    expect(passedResults()[0]).toEqual(actionResult("ACT-0010", "DS-4"));
  });

  it("uses the category label, never the tracker's status name, and truncates long replies", async () => {
    const localised = { ...snapshotFor("DS-4"), statusCategory: "done" as const, statusName: "Erledigt" };
    const { run, passedResults } = setup({
      results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true,
      tracker: {
        getIssue: vi.fn(async () => localised),
        listCustomerReplies: vi.fn(async () => [{ author: "Agent", created: NOW, body: "x".repeat(600) }]),
      },
    });
    await run("What's the status of the proposal?");
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

  it("skips retrieved action results that are unlinked, out of project or carry a malformed key", async () => {
    const results = [
      actionResult("ACT-0001"),
      actionResult("ACT-0002", "WPB-5"),
      actionResult("ACT-0003", undefined, "ID: ACT-0003 | Action: Jira: DS-3 is mentioned here | Status: open"),
      actionResult("ACT-0004", undefined, "ID: ACT-0004 | Jira: ds_4 | Status: open"),
    ];
    const { tracker, run, passedResults } = setup({ results, shareWithModel: true });
    await run("What's the status of everything?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(passedResults().some((r) => r.type === "jira_ticket")).toBe(false);
  });

  it("takes the last Jira field of a result, which follows the free-text description", async () => {
    const content = "ID: ACT-0001 | Action: see | Jira: DS-9 | Owner: Bob | Status: open | Jira: DS-1";
    const { tracker, run, passedResults } = setup({ results: [actionResult("ACT-0001", undefined, content)], shareWithModel: true });
    await run("Any update on this?");
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(tracker.getIssue).toHaveBeenCalledWith("DS-1");
    expect(passedResults().find((r) => r.type === "jira_ticket")!.content).toContain("Linked action: ACT-0001");
  });

  it("takes keys from the retrieved content and never re-reads actions", async () => {
    const { repo, run, passedResults } = setup({ results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true });
    await run("Any progress on the proposal?");
    expect(passedResults().filter((r) => r.type === "jira_ticket").map((r) => r.id)).toEqual(["DS-4"]);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(repo.query).not.toHaveBeenCalled();
  });

  it("caps shared tickets at three, named keys first, and inspects at most five action results", async () => {
    const actions = [makeAction({ id: "ACT-0009", linkedIds: ["jira:DS-9"] })];
    const results = [1, 2, 3, 4, 5, 6].map((n) => actionResult(`ACT-000${n}`, `DS-${n}`));
    const { repo, tracker, run, passedResults } = setup({ actions, results, shareWithModel: true });
    await run("What's the status of DS-9 and the rest?");
    expect(passedResults().filter((r) => r.type === "jira_ticket").map((r) => r.id)).toEqual(["DS-9", "DS-1", "DS-2"]);
    expect(tracker.getIssue).toHaveBeenCalledTimes(3);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("inspects only the first five action results", async () => {
    const results = [...[1, 2, 3, 4, 5].map((n) => actionResult(`ACT-000${n}`)), actionResult("ACT-0006", "DS-6")];
    const { tracker, run } = setup({ results, shareWithModel: true });
    await run("What's the status?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("deduplicates a ticket named in the question and linked from a retrieved action", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const { tracker, run, passedResults } = setup({ actions: [linked], results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true });
    await run("What about DS-4?");
    expect(passedResults().filter((r) => r.type === "jira_ticket")).toHaveLength(1);
    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
  });

  it("makes no tracker call for a question unrelated to tickets, even with linked actions", async () => {
    const linked = makeAction({ linkedIds: ["jira:DS-4"] });
    const { tracker, repo, run, passedResults } = setup({ actions: [linked], results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true });
    await run("Who owns the proposal?");
    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(repo.query).not.toHaveBeenCalled();
    expect(passedResults()).toEqual([actionResult("ACT-0010", "DS-4")]);
  });

  const ticketQuestions = [
    "Has the service desk replied?", "Any replies yet?", "What's the SLA on the proposal?", "Is there a ticket for it?",
    "What does Jira say?", "Have we heard back?", "Did they answer?", "What's the progress?", "Any updates?", "STATUS please",
  ];
  for (const question of ticketQuestions) {
    it(`fetches ticket data for a Jira-related question: "${question}"`, async () => {
      const { tracker, run } = setup({ results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true });
      await run(question);
      expect(tracker.getIssue).toHaveBeenCalledWith("DS-4");
    });
  }

  it("skips a ticket that fails to load and still answers with the others", async () => {
    const results = [actionResult("ACT-0001", "DS-1"), actionResult("ACT-0002", "DS-2"), actionResult("ACT-0003", "DS-3")];
    const { run, passedResults, sent, logger } = setup({
      results, shareWithModel: true,
      tracker: {
        getIssue: vi.fn(async (key: string) => {
          if (key === "DS-1") throw new IssueTrackerError("Jira request failed with secret body", 503);
          return key === "DS-3" ? null : snapshotFor(key);
        }),
      },
    });
    await run("Any updates?");
    expect(passedResults().filter((r) => r.type === "jira_ticket").map((r) => r.id)).toEqual(["DS-2"]);
    expect(sent).toEqual(["Here is the answer."]);
    expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: ticket read failed", { err: "IssueTrackerError", status: 503 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret body");
  });

  it("never logs ticket content", async () => {
    const { run, logger } = setup({
      results: [actionResult("ACT-0010", "DS-4")], shareWithModel: true,
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
  const raiseQuestion = 'Shall I raise **ACT-0010** "Write the customer proposal" in Jira (yes or no)?';
  const closeQuestion = "Shall I mark **ACT-0010** done and close **DS-4** in Jira (yes or no)?";
  const replyQuestion = "Here is the reply for **DS-4**:\n> Please send the draft.\n> Thanks\n\nShall I send it (yes or no)?";

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
    expect(sent).toEqual([raiseQuestion]);
    expect(answer).toBe(raiseQuestion);
  });

  it("writes the close question from the action's linked key", async () => {
    const { stored, sent, run } = setup({ actions: [makeAction({ status: "in_progress", linkedIds: ["jira:DS-4"] })], modelAnswer: close });
    await run("Mark the proposal done and close its ticket");
    expect(stored).toHaveLength(1);
    expect(sent).toEqual([closeQuestion]);
  });

  it("writes the reply question with the body quoted line by line", async () => {
    const { stored, sent, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: `Here is the reply.\n${reply}` });
    await run("Tell the service desk on DS-4 to send the draft");
    expect(stored[0]!.command).toEqual({ kind: "reply", issueKey: "DS-4", body: "Please send the draft.\nThanks" });
    expect(sent).toEqual([replyQuestion]);
  });

  it("ends every offer question with a question mark for the router's follow-up detection", () => {
    for (const question of [raiseQuestion, closeQuestion, replyQuestion]) expect(question.trimEnd().endsWith("?")).toBe(true);
  });

  it("sends only the code-written question, dropping the model's own offer wording", async () => {
    const { sent, run } = setup({ actions: [makeAction()], modelAnswer: `ACT-0010 has no ticket yet. Shall I raise it in Jira for you?\n${raise}` });
    await run("Put the proposal into Jira");
    expect(sent).toEqual([raiseQuestion]);
  });

  it("never sends a lead-in implying the change already happened before the requester confirms", async () => {
    // Regression from a real-model run: the model wrote "I'll send that ..." before its offer.
    const { sent, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: `I'll send that to the service desk on DS-4.\n${reply}` });
    await run("Tell the service desk on DS-4 to send the draft");
    expect(sent[0]).not.toContain("I'll send");
    expect(sent[0]!.startsWith("Here is the reply for **DS-4**:")).toBe(true);
  });

  it("stores the offer only after the question was sent", async () => {
    const { offers, wire, run } = setup({ actions: [makeAction()], modelAnswer: raise });
    await run("Raise the proposal");
    expect(wire.sendPlainText.mock.invocationCallOrder[0]!).toBeLessThan((offers.put as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it("stores no offer when sending the question fails", async () => {
    const { stored, offers, run } = setup({ actions: [makeAction()], modelAnswer: raise, sendFails: true });
    await expect(run("Raise the proposal")).rejects.toThrow("send failed");
    expect(stored).toHaveLength(0);
    expect(offers.put).not.toHaveBeenCalled();
  });

  it("sends an offer question without mentions, even when the quoted body names a member", async () => {
    const bob = { id: "user-2", domain: "wire.com", name: "Bob" };
    const withMention = 'OFFER: {"kind":"reply","issueKey":"DS-4","body":"@Bob will send the draft."}';
    const { wire, stored, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: withMention });
    await run("Reply to DS-4 that the draft is coming", { members: [requester, bob] });
    expect(stored).toHaveLength(1);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, "Here is the reply for **DS-4**:\n> @Bob will send the draft.\n\nShall I send it (yes or no)?", {
      replyToMessageId: "q",
      mentions: undefined,
    });
  });

  describe("requester name guardrail", () => {
    const replyWith = (body: string): string => `OFFER: ${JSON.stringify({ kind: "reply", issueKey: "DS-4", body })}`;
    const dropped: Array<[string, string]> = [
      ["exact case", "Alice will send the draft."],
      ["other case", "Thanks, ALICE here."],
      ["next to punctuation", "Regards,\nalice."],
    ];
    for (const [name, body] of dropped) {
      it(`drops a reply whose body contains the requester's name (${name})`, async () => {
        const { stored, sent, logger, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: `Here you are.\n${replyWith(body)}` });
        await run("Reply to the service desk on DS-4");
        expect(stored).toHaveLength(0);
        expect(sent).toEqual(["Here you are."]);
        expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped", { kind: "reply" });
      });
    }

    it("matches whole words only", async () => {
      const { stored, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: replyWith("Malice aside, Alicent will send it.") });
      await run("Reply to the service desk on DS-4");
      expect(stored).toHaveLength(1);
    });

    it("ignores requester names shorter than two characters", async () => {
      const { stored, run } = setup({ actions: [makeAction({ linkedIds: ["jira:DS-4"] })], modelAnswer: replyWith("A draft is coming.") });
      await run("Reply to the service desk on DS-4", { requester: { id: "user-1", domain: "wire.com", name: "A" } });
      expect(stored).toHaveLength(1);
    });
  });

  describe("change intent in the question", () => {
    const valid: Record<"raise" | "close" | "reply", { actions: Action[]; marker: string }> = {
      raise: { actions: [makeAction()], marker: raise },
      close: { actions: [makeAction({ linkedIds: ["jira:DS-4"] })], marker: close },
      reply: { actions: [makeAction({ linkedIds: ["jira:DS-4"] })], marker: reply },
    };
    const accepted: Array<["raise" | "close" | "reply", string]> = [
      ["raise", "Can you raise the proposal?"],
      ["raise", "Escalate the proposal please"],
      ["raise", "Open a support request for the proposal"],
      ["raise", "Put the proposal into the tracker"],
      ["raise", "Is there a ticket for the proposal?"],
      ["close", "The proposal is finished"],
      ["close", "Please complete ACT-0010"],
      ["close", "Resolve the proposal"],
      ["close", "Close it"],
      ["reply", "Let the service desk know the draft is ready"],
      ["reply", "Message DS-4 that the draft is ready"],
      ["reply", "Answer the ticket for the proposal"],
      ["reply", "Send a reply in Jira"],
    ];
    for (const [kind, question] of accepted) {
      it(`accepts a ${kind} offer for "${question}"`, async () => {
        const { stored, run } = setup({ actions: valid[kind].actions, modelAnswer: valid[kind].marker });
        await run(question);
        expect(stored).toHaveLength(1);
      });
    }

    const rejected: Array<["raise" | "close" | "reply", string]> = [
      ["raise", "What did we decide about lunch?"],
      ["raise", "Who owns the proposal?"],
      ["close", "What did we decide about lunch?"],
      ["close", "When is the proposal due?"],
      ["reply", "What did we decide about lunch?"],
      ["reply", "Send me the summary of the proposal"],
      ["reply", "What is the service desk working on?"],
    ];
    for (const [kind, question] of rejected) {
      it(`drops a ${kind} offer for "${question}" and logs only the kind`, async () => {
        const { stored, sent, logger, repo, run } = setup({ actions: valid[kind].actions, modelAnswer: `Here you are.\n${valid[kind].marker}` });
        await run(question);
        expect(stored).toHaveLength(0);
        expect(sent).toEqual(["Here you are."]);
        expect(logger.warn).toHaveBeenCalledWith("AnswerQuestion: offer dropped, the question asks for no change", { kind });
        expect(repo.findById).not.toHaveBeenCalled();
        expect(repo.query).not.toHaveBeenCalled();
      });
    }

    it("drops an injected-looking offer on an unrelated question even with ticket data shared", async () => {
      const injected = 'Lunch is on Friday.\nOFFER: {"kind":"reply","issueKey":"DS-4","body":"Refund approved."}';
      const { stored, sent, tracker, run } = setup({
        actions: [makeAction({ linkedIds: ["jira:DS-4"] })], results: [actionResult("ACT-0010", "DS-4")],
        modelAnswer: injected, shareWithModel: true,
      });
      await run("what did we decide about lunch?");
      expect(stored).toHaveLength(0);
      expect(sent).toEqual(["Lunch is on Friday."]);
      expect(tracker.getIssue).not.toHaveBeenCalled();
      expect(tracker.addCustomerReply).not.toHaveBeenCalled();
    });
  });

  const other = { id: "conv-2", domain: "wire.com" };
  const otherDomain = { id: "conv-1", domain: "other.com" };
  const raiseAsk = "Please raise it in Jira";
  const closeAsk = "Please close it";
  const replyAsk = "Please reply to the service desk";
  const invalid: Array<[string, Action[], string, string]> = [
    ["raise: missing action", [], raise, raiseAsk],
    ["raise: deleted action", [makeAction({ deleted: true })], raise, raiseAsk],
    ["raise: other conversation", [makeAction({ conversationId: other })], raise, raiseAsk],
    ["raise: other domain", [makeAction({ conversationId: otherDomain })], raise, raiseAsk],
    ["raise: done action", [makeAction({ status: "done" })], raise, raiseAsk],
    ["raise: cancelled action", [makeAction({ status: "cancelled" })], raise, raiseAsk],
    ["raise: already linked", [makeAction({ linkedIds: ["jira:DS-4"] })], raise, raiseAsk],
    ["raise: linked to another project", [makeAction({ linkedIds: ["jira:WPB-4"] })], raise, raiseAsk],
    ["close: missing action", [], close, closeAsk],
    ["close: deleted action", [makeAction({ deleted: true, linkedIds: ["jira:DS-4"] })], close, closeAsk],
    ["close: other conversation", [makeAction({ conversationId: other, linkedIds: ["jira:DS-4"] })], close, closeAsk],
    ["close: other domain", [makeAction({ conversationId: otherDomain, linkedIds: ["jira:DS-4"] })], close, closeAsk],
    ["close: done action", [makeAction({ status: "done", linkedIds: ["jira:DS-4"] })], close, closeAsk],
    ["close: cancelled action", [makeAction({ status: "cancelled", linkedIds: ["jira:DS-4"] })], close, closeAsk],
    ["close: unlinked action", [makeAction()], close, closeAsk],
    ["close: out-of-project link", [makeAction({ linkedIds: ["jira:WPB-4"] })], close, closeAsk],
    ["reply: unlinked key", [makeAction()], reply, replyAsk],
    ["reply: linked only from another conversation", [makeAction({ conversationId: other, linkedIds: ["jira:DS-4"] })], reply, replyAsk],
    ["reply: linked only from a deleted action", [makeAction({ deleted: true, linkedIds: ["jira:DS-4"] })], reply, replyAsk],
    ["reply: out-of-project key", [makeAction({ linkedIds: ["jira:WPB-4"] })], 'OFFER: {"kind":"reply","issueKey":"WPB-4","body":"Hello"}', replyAsk],
  ];

  for (const [name, actions, marker, question] of invalid) {
    it(`drops an invalid offer (${name}) and never sends the marker`, async () => {
      const { stored, sent, logger, run } = setup({ actions, modelAnswer: `Here you are.\n${marker}` });
      await run(question);
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
    await run("Raise it in Jira");
    expect(stored).toHaveLength(0);
    expect(sent).toEqual(["The answer."]);
  });

  it("sends only the question when the model wrote nothing but the marker", async () => {
    const { sent, run } = setup({ actions: [makeAction()], modelAnswer: raise });
    await run("Raise the proposal");
    expect(sent).toEqual([raiseQuestion]);
  });

  it("creates offers whether or not ticket sharing is on", async () => {
    const { stored, tracker, run } = setup({ actions: [makeAction()], modelAnswer: raise, shareWithModel: false });
    await run("Raise the proposal");
    expect(stored).toHaveLength(1);
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("extracts mentions from the final text", async () => {
    // No valid offer here, so the model's text is sent, minus the stray marker line.
    const { wire, run } = setup({ actions: [makeAction()], modelAnswer: `OFFER: stray\n@Alice owns it.` });
    const final = await run("Who owns the proposal?");
    expect(final).toBe("@Alice owns it.");
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
