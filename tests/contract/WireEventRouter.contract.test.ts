/**
 * Contract tests for WireEventRouter.
 *
 * These tests verify that the router correctly maps incoming SDK text messages
 * to the expected application use-case calls. They use fully-stubbed use cases
 * and ports — no DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireReplyContext } from "../../src/infrastructure/wire/WireReplyContext";
import { createWireOutboundAdapter } from "../../src/infrastructure/wire/WireOutboundAdapter";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { MemberCacheUserResolutionService } from "../../src/infrastructure/services/MemberCacheUserResolutionService";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const sender: QualifiedId = { id: "user-1", domain: "wire.com" };

function makeMessage(text: string, id = "msg-1") {
  return { id, text, conversationId: convId, sender };
}

function customMention(command: string) {
  const label = "@AI Team Bot 🤖 (test, staging)";
  return { ...makeMessage(`${label} ${command}`), mentions: [
    { userId: { id: "bot-1", domain: "wire.com" }, offset: 0, length: label.length },
  ] };
}

it.each([
  "@Adam (Test) needs to prepare the slide deck by this Friday.",
  "we really need to get this presentation to Yellow Taxis done by Monday, @Adam (Test) really needs to prepare the slide deck by this Friday.",
  "we really need to get this presentation done by Monday, @Adam (Test) needs to prepare the slide deck by this Friday.",
])("records a clear addressed assignment with its own deadline: %s", async text => {
  const enqueue = vi.fn();
  const deps = makeDeps({ processingQueue: { enqueue } as never, pipeline: {} as never });
  const message = customMention(text);
  message.mentions.push({ userId: { id: "target", domain: "wire.com" }, offset: message.text.indexOf("@Adam"), length: "@Adam (Test)".length });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledOnce();
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({
    description: "prepare the slide deck", assigneeReference: "@Adam (Test)", assigneeId: { id: "target", domain: "wire.com" }, deadlineText: "this Friday",
    creatorId: sender, conversationId: convId, rawMessageId: "msg-1",
  }));
  expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

it.each(["@Adam really", "@Maybe Needs To", "@Adam, Low 🤖"])("uses the structured owner despite grammar in the label: %s", async label => {
  const deps = makeDeps();
  const message = customMention(`${label} really needs to prepare the deck by Friday`);
  message.mentions.push({ userId: { id: "target", domain: "remote.test" }, offset: message.text.indexOf(label), length: label.length });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({
    assigneeId: { id: "target", domain: "remote.test" }, assigneeReference: label,
    description: "prepare the deck", deadlineText: "Friday",
  }));
});

it("does not attach a mentioned task participant as the unmentioned owner", async () => {
  const deps = makeDeps();
  const message = customMention("@Alice needs to discuss slides with @Bob by Friday");
  message.mentions.push({ userId: { id: "bob", domain: "wire.com" }, offset: message.text.indexOf("@Bob"), length: 4 });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({
    assigneeReference: "@Alice", assigneeId: undefined, description: "discuss slides with @Bob",
  }));
});

it.each(["out-of-bounds", "overlap", "fractional"])("refuses malformed person mention spans: %s", async variant => {
  const deps = makeDeps();
  const message = customMention("@Adam needs to prepare slides by Friday");
  const mention = { userId: { id: "target", domain: "wire.com" }, offset: message.text.indexOf("@Adam"), length: 5 };
  if (variant === "out-of-bounds") mention.length = 10000;
  if (variant === "fractional") mention.offset += 0.5;
  message.mentions.push(mention);
  if (variant === "overlap") message.mentions.push({ ...mention });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.createActionFromExplicit.execute).not.toHaveBeenCalled();
});

it.each(["action: prepare slides for @Adam", "`action: prepare slides for` @Adam", "action: @Adam to prepare slides"])("preserves actual mention identity for explicit creation: %s", async text => {
  const deps = makeDeps();
  const message = customMention(text);
  message.mentions.push({ userId: { id: "target", domain: "remote.test" }, offset: message.text.indexOf("@Adam"), length: 5 });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({
    assigneeReference: "@Adam", assigneeId: { id: "target", domain: "remote.test" }, description: "prepare slides",
  }));
});

it.each([
  "Does @Adam (Test) need to prepare the slide deck by Friday?",
  "@Adam (Test) needs to prepare the slide deck by Friday?",
  "If we proceed, @Adam (Test) needs to prepare the slide deck by Friday.",
  "@Adam (Test) does not need to prepare the slide deck by Friday.",
  "@Adam (Test) no longer needs to prepare the slide deck by Friday.",
  "Example: @Adam (Test) needs to prepare the slide deck by Friday.",
  "@Adam (Test) needs to prepare slides and @Bob needs to review them by Friday.",
  "we really need to get this presentation done by Monday.",
])("does not turn questions, uncertainty or ambiguous assignments into writes: %s", async text => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
  expect(deps.createActionFromExplicit.execute).not.toHaveBeenCalled();
});

it("does not create addressed natural assignments while secure", async () => {
  const deps = makeDeps();
  const router = new WireEventRouter(deps);
  await router.onTextMessageReceived(customMention("secure mode"));
  await router.onTextMessageReceived(customMention("@Adam (Test) needs to prepare the slide deck by Friday."));
  expect(deps.createActionFromExplicit.execute).not.toHaveBeenCalled();
});

it("creates an addressed natural assignment while paused, since it mentions the bot", async () => {
  const deps = makeDeps();
  const router = new WireEventRouter(deps);
  await router.onTextMessageReceived(customMention("pause"));
  await router.onTextMessageReceived(customMention("@Adam (Test) needs to prepare the slide deck by Friday."));
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({ description: "prepare the slide deck", deadlineText: "Friday" }));
  expect(deps.messageBuffer.push).not.toHaveBeenCalled();
});

it.each([
  "`remind me in 2 minutes to check the smoke reminder`",
  "`remind me` in 2 minutes to check the smoke reminder",
])("routes a pasted reminder to creation without Q&A: %s", async text => {
  for (const addressed of [false, true]) {
    const enqueue = vi.fn();
    const triggerAt = new Date("2026-09-17T12:02:00Z");
    const deps = makeDeps({ processingQueue: { enqueue } as never, pipeline: {} as never });
    vi.mocked(deps.dateTimeService.parse).mockReturnValue({ value: triggerAt } as never);
    await new WireEventRouter(deps).onTextMessageReceived(addressed ? customMention(text) : makeMessage(text));
    expect(deps.createReminder.execute).toHaveBeenCalledWith(expect.objectContaining({
      description: "check the smoke reminder", targetId: sender, triggerAt, conversationId: convId,
    }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  }
});

it.each([
  ["`cancel REM-0001`", "cancelReminder"],
  ["`snooze REM-0001 1 hour`", "snoozeReminder"],
  ["`show reminders`", "listMyReminders"],
  ["`decision: use Postgres`", "logDecision"],
  ["`decision: use Postgres 16 supersedes DEC-0001`", "supersedeDecision"],
  ["`revoke DEC-0001 wrong call`", "revokeDecision"],
  ["`action: review the checklist`", "createActionFromExplicit"],
  ["`my actions`", "listMyActions"],
] as const)("keeps pasted supported commands on their existing route: %s", async (text, useCase) => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
  expect(deps[useCase].execute).toHaveBeenCalledOnce();
  expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
});

it.each(["pause", "secure mode"])("keeps pasted %s and resume subject to real-mention controls", async state => {
  const deps = makeDeps();
  const router = new WireEventRouter(deps);
  await router.onTextMessageReceived(customMention(`\`${state}\``));
  expect(deps.channelConfig.setState).toHaveBeenLastCalledWith("conv-1@wire.com", state === "pause" ? "paused" : "secure", sender.id, expect.any(Date));
  await router.onTextMessageReceived(makeMessage("`resume`"));
  expect(deps.channelConfig.setState).toHaveBeenCalledTimes(1);
  await router.onTextMessageReceived(customMention("`resume`"));
  expect(deps.channelConfig.setState).toHaveBeenLastCalledWith("conv-1@wire.com", "active", sender.id, expect.any(Date));
});

it.each(["Example: `remind me in 2 minutes to check`", "```remind me in 2 minutes to check```", "`remind me in 2 minutes\nto check`"])("does not turn quoted prose, fences or multiline code into reminders: %s", async text => {
  const deps = makeDeps();
  vi.mocked(deps.dateTimeService.parse).mockReturnValue({ value: new Date() } as never);
  await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
  expect(deps.createReminder.execute).not.toHaveBeenCalled();
});

it.each([
  "ACT-0002 reassign to @Adam (Test)",
  "`ACT-0002 reassign to` @Adam (Test)",
  "`ACT-0002` reassign to @Adam (Test)",
  "`ACT-0002 reassign to @Adam (Test)`",
])("routes a pasted reassignment with a person mention: %s", async text => {
  for (const addressed of [false, true]) {
    const enqueue = vi.fn();
    const deps = makeDeps({ processingQueue: { enqueue } as never, pipeline: {} as never });
    const message = addressed ? customMention(text) : { ...makeMessage(text), mentions: [] };
    message.mentions.push({ userId: { id: "target", domain: "wire.com" }, offset: message.text.indexOf("@Adam"), length: "@Adam (Test)".length });
    await new WireEventRouter(deps).onTextMessageReceived(message);
    expect(deps.reassignAction.execute).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "ACT-0002", newAssigneeReference: "@Adam (Test)", newAssigneeId: { id: "target", domain: "wire.com" }, conversationId: convId,
    }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  }
});

it.each(["Here is an example: `ACT-0002 done`", "```ACT-0002 done```", "`ACT-0002 done\nACT-0003 done`"])("does not execute quoted examples or multiple commands: %s", async text => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
  expect(deps.updateActionStatus.execute).not.toHaveBeenCalled();
  expect(deps.reassignAction.execute).not.toHaveBeenCalled();
});

it("routes a real mention with an arbitrary display name to the caller's action list", async () => {
  const deps = makeDeps();
  const caller = { id: "second-user", domain: "wire.com" };
  await new WireEventRouter(deps).onTextMessageReceived({ ...customMention("my actions"), sender: caller });
  expect(deps.listMyActions.execute).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: caller, conversationId: convId }));
  expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
});

it.each(["pause", "secure mode"])("routes %s and resume by qualified mention span", async command => {
  const deps = makeDeps();
  const router = new WireEventRouter(deps);
  await router.onTextMessageReceived(customMention(command));
  expect(deps.channelConfig.setState).toHaveBeenCalledWith("conv-1@wire.com", command === "pause" ? "paused" : "secure", sender.id, expect.any(Date));
  await router.onTextMessageReceived(customMention("resume"));
  expect(deps.channelConfig.setState).toHaveBeenLastCalledWith("conv-1@wire.com", "active", sender.id, expect.any(Date));
});

it("passes the actual caller and cleaned question after a custom bot mention", async () => {
  const caller = { id: "second-user", domain: "wire.com" };
  const memberCache = new InMemoryMemberCache();
  memberCache.setMembers(convId, [{ userId: caller, role: "member", name: "Second User" }]);
  const deps = makeDeps({ memberCache });
  await new WireEventRouter(deps).onTextMessageReceived({ ...customMention("What am I responsible for?"), sender: caller });
  expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
    question: "What am I responsible for?", requester: { ...caller, name: "Second User" },
  }));
});

it("shows the app typing while it answers a mentioned question, and clears it afterwards", async () => {
  const deps = makeDeps();
  vi.mocked(deps.answerQuestion.execute).mockImplementation(async () => {
    expect(vi.mocked(deps.wireOutbound.setTyping).mock.calls).toEqual([[convId, true]]);
    return "answer";
  });
  await new WireEventRouter(deps).onTextMessageReceived(customMention("What am I responsible for?"));
  await vi.waitFor(() => expect(vi.mocked(deps.wireOutbound.setTyping).mock.calls.at(-1)).toEqual([convId, false]));
});

it("does not show typing for an ordinary message nobody asked the bot about", async () => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(makeMessage("lunch at noon?"));
  expect(deps.wireOutbound.setTyping).not.toHaveBeenCalled();
});

it("routes an action status question to record retrieval, not channel status", async () => {
  const deps = makeDeps({ statusCommand: { execute: vi.fn() } as never });
  await new WireEventRouter(deps).onTextMessageReceived(customMention("What is the status and owner of ACT-0002?"));
  expect(deps.statusCommand!.execute).not.toHaveBeenCalled();
  expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ question: "What is the status and owner of ACT-0002?" }));
});

it.each(["status", "channel status?"])("retains the explicit channel command %s", async command => {
  const deps = makeDeps({ statusCommand: { execute: vi.fn() } as never });
  await new WireEventRouter(deps).onTextMessageReceived(customMention(command));
  expect(deps.statusCommand!.execute).toHaveBeenCalledOnce();
  expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
});

it.each(["foreign", "invalid", "nonleading"])("does not strip a %s mention into a command", async variant => {
  const deps = makeDeps();
  const message = customMention("my actions");
  if (variant === "foreign") message.mentions[0].userId.domain = "other.test";
  if (variant === "invalid") message.mentions[0].length = 10000;
  if (variant === "nonleading") { message.text = `hello ${message.text}`; message.mentions[0].offset = 6; }
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.listMyActions.execute).not.toHaveBeenCalled();
});

it.each([
  ["action: review the smoke checklist for @second_test by Friday", "@second_test"],
  ["action: @second_test to review the smoke checklist by Friday", "@second_test"],
  ["action: review the smoke checklist for Adam (Test) by Friday", "Adam (Test)"],
])("preserves an explicit assignee in %s", async (text, assigneeReference) => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({
    assigneeReference, description: "review the smoke checklist", deadlineText: "Friday",
  }));
});

it("hydrates Wire handles before resolving an owner after restart", async () => {
  const memberCache = new InMemoryMemberCache();
  const member = { id: "second-user", domain: "wire.com" };
  const deps = makeDeps({ memberCache });
  deps.wireOutbound.getUserProfile = vi.fn().mockResolvedValue({ id: member, name: "Adam (Test)", handle: "second_test" });
  await new WireEventRouter(deps).hydrateFromSdkStore([convId] as never, async () => [{ userId: member, role: "wire_member" }] as never);
  expect(await new MemberCacheUserResolutionService(memberCache).resolveByHandleOrName("@second_test", { conversationId: convId }))
    .toEqual({ userId: member, ambiguous: false });
});

function makeDeps(overrides: Partial<WireEventRouterDeps> = {}): WireEventRouterDeps {
  return {
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // Decisions
    logDecision: { execute: vi.fn().mockResolvedValue({ id: "DEC-0001" }) },
    searchDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    listDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    supersedeDecision: { execute: vi.fn().mockResolvedValue(null) },
    revokeDecision: { execute: vi.fn().mockResolvedValue(null) },
    // Actions
    createActionFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "ACT-0001" }) },
    updateActionStatus: { execute: vi.fn().mockResolvedValue(null) },
    reassignAction: { execute: vi.fn().mockResolvedValue(null) },
    updateActionDeadline: { execute: vi.fn().mockResolvedValue(null) },
    listMyActions: { execute: vi.fn().mockResolvedValue([]) },
    listTeamActions: { execute: vi.fn().mockResolvedValue([]) },
    listOverdueActions: { execute: vi.fn().mockResolvedValue([]) },
    // Reminders
    createReminder: { execute: vi.fn().mockResolvedValue({ id: "REM-0001" }) },
    listMyReminders: { execute: vi.fn().mockResolvedValue([]) },
    cancelReminder: { execute: vi.fn().mockResolvedValue(null) },
    snoozeReminder: { execute: vi.fn().mockResolvedValue(null) },
    // General
    answerQuestion: { execute: vi.fn().mockResolvedValue(undefined) },
    // Infrastructure identity
    botUserId: { id: "bot-1", domain: "wire.com" },
    wireOutbound: {
      sendPlainText: vi.fn().mockResolvedValue(undefined),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      setTyping: vi.fn().mockResolvedValue(undefined),
    },
    messageBuffer: { clear: vi.fn(), push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    dateTimeService: { parse: vi.fn().mockReturnValue(null) },
    memberCache: {
      setMembers: vi.fn(), addMembers: vi.fn(), getMembers: vi.fn().mockReturnValue([]),
      removeMembers: vi.fn(), clearConversation: vi.fn(),
    },
    conversationConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setState: vi.fn(), setTimezone: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]) },
    slidingWindow: { push: vi.fn(), getWindow: vi.fn().mockReturnValue([]), flush: vi.fn(), clear: vi.fn() },
    scheduler: { schedule: vi.fn(), cancel: vi.fn(), setHandler: vi.fn() },
    secretModeInactivityMs: 600_000,
    ...overrides,
  } as unknown as WireEventRouterDeps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast-path routing (no LLM call)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: fast-path routing", () => {
  let deps: WireEventRouterDeps;
  let router: WireEventRouter;

  beforeEach(() => {
    deps = makeDeps();
    router = new WireEventRouter(deps);
  });

  it("'TASK-0001 done' → sends graceful redirect (tasks consolidated)", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 done"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("actions"),
      expect.anything(),
    );
  });

  it("'close TASK-0001' → sends graceful redirect (tasks consolidated)", async () => {
    await router.onTextMessageReceived(makeMessage("close TASK-0001"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("actions"),
      expect.anything(),
    );
  });

  it("'ACT-0001 done' → updateActionStatus", async () => {
    await router.onTextMessageReceived(makeMessage("ACT-0001 done"));
    expect(deps.updateActionStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newStatus: "done" }),
    );
  });

  it("'close ACT-0001' → updateActionStatus with status done", async () => {
    await router.onTextMessageReceived(makeMessage("close ACT-0001"));
    expect(deps.updateActionStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newStatus: "done" }),
    );
  });

  it("'ACT-0001 reassign to @bob' → reassignAction", async () => {
    await router.onTextMessageReceived(makeMessage("ACT-0001 reassign to @bob"));
    expect(deps.reassignAction.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newAssigneeReference: "@bob" }),
    );
  });

  it("'assign ACT-0001 to mark' → reassignAction", async () => {
    await router.onTextMessageReceived(makeMessage("assign ACT-0001 to mark"));
    expect(deps.reassignAction.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newAssigneeReference: "mark" }),
    );
  });

  it("'TASK-0001 reassign to alice' → sends graceful redirect (tasks consolidated)", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 reassign to alice"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("actions"),
      expect.anything(),
    );
  });

  it("'revoke DEC-0001 wrong call' → revokeDecision", async () => {
    await router.onTextMessageReceived(makeMessage("revoke DEC-0001 wrong call"));
    expect(deps.revokeDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: "DEC-0001", reason: "wrong call", actorId: sender }),
    );
  });

  it("'cancel REM-0001' → cancelReminder fast-path", async () => {
    await router.onTextMessageReceived(makeMessage("cancel REM-0001"));
    expect(deps.cancelReminder.execute).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: "REM-0001" }),
    );
  });

  it("'forget KB-0001' → sends graceful message (KB being rebuilt)", async () => {
    await router.onTextMessageReceived(makeMessage("forget KB-0001"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringMatching(/knowledge|rebuilt/i),
      expect.anything(),
    );
  });

  it("'update KB-0001 new text' → sends graceful message (KB being rebuilt)", async () => {
    await router.onTextMessageReceived(makeMessage("update KB-0001 new text"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringMatching(/knowledge|rebuilt/i),
      expect.anything(),
    );
  });

  it("'list decisions' exact-match → listDecisions", async () => {
    await router.onTextMessageReceived(makeMessage("list decisions"));
    expect(deps.listDecisions.execute).toHaveBeenCalledOnce();
  });

  it("'my tasks' exact-match → redirects to listMyActions", async () => {
    await router.onTextMessageReceived(makeMessage("my tasks"));
    expect(deps.listMyActions.execute).toHaveBeenCalledOnce();
  });

  it("'team tasks' exact-match → redirects to listTeamActions", async () => {
    await router.onTextMessageReceived(makeMessage("team tasks"));
    expect(deps.listTeamActions.execute).toHaveBeenCalledOnce();
  });

  it("'my actions' exact-match → listMyActions", async () => {
    await router.onTextMessageReceived(makeMessage("my actions"));
    expect(deps.listMyActions.execute).toHaveBeenCalledOnce();
  });

  it("'overdue actions' exact-match → listOverdueActions", async () => {
    await router.onTextMessageReceived(makeMessage("overdue actions"));
    expect(deps.listOverdueActions.execute).toHaveBeenCalledOnce();
  });

  it("'show reminders' exact-match → listMyReminders", async () => {
    await router.onTextMessageReceived(makeMessage("show reminders"));
    expect(deps.listMyReminders.execute).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit-command routing (no LLM)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: explicit command routing", () => {
  it("decision: <text> → logDecision", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("decision: Use Postgres"));
    expect(deps.logDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Use Postgres" }),
    );
  });

  it("action: <text> → createActionFromExplicit", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("action: Write the spec"));
    expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Write the spec" }),
    );
  });

  it("decisions about <query> → searchDecisions", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("decisions about auth"));
    expect(deps.searchDecisions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "auth" }),
    );
  });

  it("search decisions <query> → searchDecisions", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("search decisions rate limiting"));
    expect(deps.searchDecisions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "rate limiting" }),
    );
  });

  it("remind me <time> to <desc> with parseable time → createReminder", async () => {
    const parsedDate = new Date("2026-03-16T15:00:00Z");
    const deps = makeDeps({
      dateTimeService: { parse: vi.fn().mockReturnValue({ value: parsedDate }) },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("remind me at 3pm to call John"));
    expect(deps.createReminder.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "call John", triggerAt: parsedDate }),
    );
  });

  it("remind me <time> to <desc> with unparseable time → error, no reminder created", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("remind me someday to call John"));
    expect(deps.createReminder.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("couldn't parse"),
      expect.anything(),
    );
  });

  it("non-command message without bot mention → bot stays silent", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("yes its set up for tomorrow"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// General behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: general behaviour", () => {
  let deps: WireEventRouterDeps;
  let router: WireEventRouter;

  beforeEach(() => {
    deps = makeDeps();
    router = new WireEventRouter(deps);
  });

  it("pushes every message to the message buffer", async () => {
    await router.onTextMessageReceived(makeMessage("hello world"));
    expect(deps.messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ text: "hello world" }));
  });

  it("sends error reply when a use case throws", async () => {
    const d = makeDeps();
    vi.mocked(d.createActionFromExplicit.execute).mockRejectedValueOnce(new Error("boom"));
    const r = new WireEventRouter(d);
    await r.onTextMessageReceived(makeMessage("action: crash this"));
    expect(d.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("Something went wrong"),
      expect.anything(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Button action handling
// ─────────────────────────────────────────────────────────────────────────────
function makeButtonAction(buttonId: string, referenceMessageId = "msg-1", id = "btn-1") {
  return { id, buttonId, referenceMessageId, conversationId: convId, sender };
}

describe("WireEventRouter contract: button action handling", () => {
  it("unknown button id → gives a supported text alternative", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onButtonClicked(makeButtonAction("unknown_button"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringContaining("text command"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Member cache lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: member cache lifecycle", () => {
  it("setMembers on app-added", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    const conv = { id: "conv-1", domain: "wire.com" };
    const members = [{ userId: sender, role: "member" }];
    await router.onAppAddedToConversation(conv, members);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringMatching(/📝.*save an action.*✅.*save a completion/));
    expect(deps.memberCache.setMembers).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv-1" }),
      expect.any(Array),
    );
  });

  it("explains the service desk first in the welcome when it is configured", async () => {
    const deps = makeDeps({ supportWelcome: { projectKey: "DS", passive: true, watching: true } } as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onAppAddedToConversation({ id: "conv-1", domain: "wire.com" }, [{ userId: sender, role: "member" }]);
    const text = vi.mocked(deps.wireOutbound.sendPlainText).mock.calls[0]![1];
    expect(text).toMatch(/^I'm Wire Team Bot, and I connect this channel with the service desk\./);
    expect(text).toMatch(/📝.*save an action.*✅.*save a completion/s);
  });

  it("addMembers (not setMembers) on user-joined", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    const members = [{ userId: { id: "user-2", domain: "wire.com" }, role: "member" }];
    await router.onUserJoinedConversation(convId, members);
    expect(deps.memberCache.addMembers).toHaveBeenCalledWith(convId, expect.any(Array));
    expect(deps.memberCache.setMembers).not.toHaveBeenCalled();
  });

  it("removeMembers on user-left", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onUserLeftConversation(convId, [sender]);
    expect(deps.memberCache.removeMembers).toHaveBeenCalledWith(convId, [sender]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Pipeline enqueue behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: Phase 2 pipeline enqueue", () => {
  function makeQueueDeps() {
    const enqueueSpy = vi.fn();
    const processSpy = vi.fn().mockResolvedValue(undefined);
    const queue = {
      enqueue: enqueueSpy,
      setWorker: vi.fn(),
      depth: 0,
      concurrency: 0,
    };
    const pipeline = { process: processSpy };
    return { queue, pipeline, enqueueSpy, processSpy };
  }

  it("enqueues a job for every ACTIVE channel message", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      orgId: "wire.com",
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("hello there"));
    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: `${convId.id}@${convId.domain}`,
        payload: expect.objectContaining({ text: "hello there" }),
      }),
    );
  });

  it("does NOT enqueue when pipeline deps are absent", async () => {
    const deps = makeDeps();  // no processingQueue or pipeline
    const router = new WireEventRouter(deps);
    // Just ensure it does not throw
    await expect(router.onTextMessageReceived(makeMessage("hello there"))).resolves.toBeUndefined();
  });

  it("does NOT enqueue when channel is PAUSED (no bot mention)", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      channelConfig: {
        get: vi.fn().mockResolvedValue({ state: "paused", secureRanges: [], timezone: "UTC", locale: "en", organisationId: "wire.com", channelId: `${convId.id}@${convId.domain}` }),
        upsert: vi.fn(), setState: vi.fn(), setTimezone: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("just talking"));
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when channel is SECURE", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      channelConfig: {
        get: vi.fn().mockResolvedValue({ state: "secure", secureRanges: [], timezone: "UTC", locale: "en", organisationId: "wire.com", channelId: `${convId.id}@${convId.domain}` }),
        upsert: vi.fn(), setState: vi.fn(), setTimezone: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("confidential stuff"));
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: CatchMeUpCommand routing
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: Phase 4 catch me up routing", () => {
  function makeCatchMeUpCommand() {
    return { execute: vi.fn().mockResolvedValue(undefined) };
  }

  function makeMsg(text: string) {
    return {
      id: "msg-1",
      text,
      conversationId: convId,
      sender: { ...sender },
      mentions: [{ userId: { id: "bot-1", domain: "wire.com" } }],
    };
  }

  it("'@Wire Team Bot catch me up' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = makeCatchMeUpCommand();
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("catch me up"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
    expect(catchMeUpCommand.execute).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: `${convId.id}@${convId.domain}` }),
    );
  });

  it("'@Wire Team Bot what did I miss' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = makeCatchMeUpCommand();
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("what did I miss"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
  });

  it("'@Wire Team Bot what's new' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = makeCatchMeUpCommand();
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("what's new"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
  });

  it("catch me up without catchMeUpCommand dep → falls through to intelligence path", async () => {
    const deps = makeDeps(); // no catchMeUpCommand
    const router = new WireEventRouter(deps);
    // Bot is mentioned so answerQuestion would be called if intelligence path reached
    const msg = makeMsg("catch me up");
    await router.onTextMessageReceived(msg);
    // catchMeUpCommand absent — should not throw, router continues
    expect(deps.wireOutbound.sendPlainText).not.toThrow();
  });
});

describe("privacy state contract", () => {
  const addressed = (text: string) => ({ ...makeMessage(text), mentions: [{ userId: { id: "bot-1", domain: "wire.com" } }] });
  it.each(["pause", "secure mode"])("clears both buffers and discards %s-period text across resume", async command => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("before"));
    await router.onTextMessageReceived(addressed(command));
    expect(deps.messageBuffer.clear).toHaveBeenCalledWith(convId);
    expect(deps.slidingWindow.flush).toHaveBeenCalledWith("conv-1@wire.com");
    vi.mocked(deps.messageBuffer.push).mockClear();
    vi.mocked(deps.slidingWindow.push).mockClear();
    await router.onTextMessageReceived(makeMessage("EXCLUDED_MARKER"));
    expect(deps.messageBuffer.push).not.toHaveBeenCalled();
    expect(deps.slidingWindow.push).not.toHaveBeenCalled();
    await router.onTextMessageReceived(addressed("resume"));
    await router.onTextMessageReceived(makeMessage("after"));
    expect(JSON.stringify(vi.mocked(deps.messageBuffer.push).mock.calls)).not.toContain("EXCLUDED_MARKER");
  });
  it("restores secure state before buffering on restart", async () => {
    const deps = makeDeps();
    vi.mocked(deps.channelConfig.get).mockResolvedValue({ state: "secure" } as never);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("EXCLUDED_MARKER"));
    expect(deps.messageBuffer.push).not.toHaveBeenCalled();
    expect(deps.slidingWindow.push).not.toHaveBeenCalled();
  });
  it("does not resume after a failed state write", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(addressed("pause"));
    vi.mocked(deps.channelConfig.setState).mockRejectedValue(new Error("DB down"));
    await router.onTextMessageReceived(addressed("resume"));
    await router.onTextMessageReceived(makeMessage("decision: excluded"));
    expect(deps.logDecision.execute).not.toHaveBeenCalled();
  });
  it("keeps mentioned explicit commands and questions out of passive extraction", async () => {
    const enqueue = vi.fn();
    const deps = makeDeps({ processingQueue: { enqueue } as never, pipeline: {} as never });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(addressed("@Wire Team Bot decision: use Postgres"));
    await router.onTextMessageReceived(addressed("@Wire Team Bot what did we decide?"));
    expect(deps.logDecision.execute).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

it("passes a named action's deadline separately from its description", async () => {
  const deps=makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(makeMessage("action: Bob to review the contract by Friday"));
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({description:"review the contract",assigneeReference:"Bob",deadlineText:"Friday"}));
});

it("accepts the Wire Team Bot name for control and explicit capture commands", async () => {
  const deps=makeDeps();
  const router=new WireEventRouter(deps);
  await router.onTextMessageReceived(makeMessage("@Wire Team Bot decision: use Postgres"));
  expect(deps.logDecision.execute).toHaveBeenCalledWith(expect.objectContaining({summary:"use Postgres"}));
  await router.onTextMessageReceived(makeMessage("@Wire Team Bot pause"));
  expect(deps.channelConfig.setState).toHaveBeenCalledWith("conv-1@wire.com","paused",sender.id,expect.any(Date));
});
it("parses the documented for-owner form followed by a deadline", async () => {
  const deps=makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(makeMessage("action: review the checklist for Bob by Friday"));
  expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(expect.objectContaining({description:"review the checklist",assigneeReference:"Bob",deadlineText:"Friday"}));
});


it("quotes each actual source across overlapping channels and queued commands", async () => {
  const context = new WireReplyContext();
  const sendMessage = vi.fn().mockResolvedValue("sent");
  const deps = makeDeps({ replyContext: context });
  const adapter = createWireOutboundAdapter({ current: { manager: { sendMessage, sendAsset: vi.fn(), getUsers: vi.fn().mockResolvedValue([]) } } }, deps.logger, context);
  deps.wireOutbound = adapter;
  let release!: () => void;
  let entered!: () => void;
  const enteredFirst = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  deps.listMyActions.execute = vi.fn(async input => {
    if (input.conversationId.domain === convId.domain && input.replyToMessageId === "first") {
      entered();
      await blocked;
    }
    await adapter.sendPlainText(input.conversationId, `list ${input.replyToMessageId}`, { replyToMessageId: input.replyToMessageId });
    return [];
  });
  const router = new WireEventRouter(deps);
  const source = (id: string, domain = convId.domain) => TextMessage.create({
    conversationId: { ...convId, domain }, messageId: id, text: "my actions", senderId: sender,
    timestamp: new Date("2026-09-18T09:00:00Z"),
  });
  const first = router.onTextMessageReceived(source("first"));
  await enteredFirst;
  const second = router.onTextMessageReceived(source("second"));
  await router.onTextMessageReceived(source("first", "other.test"));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0][0]).toMatchObject({ conversationId: { ...convId, domain: "other.test" }, quotedMessageId: "first" });
  release();
  await Promise.all([first, second]);
  expect(sendMessage.mock.calls.slice(1).map(([m]) => [m.text, m.quotedMessageId])).toEqual([["list first", "first"], ["list second", "second"]]);
  expect(context.get(convId, "first")).toBeUndefined();
  expect(context.get(convId, "second")).toBeUndefined();
});

it("quotes router error responses and clears their source metadata", async () => {
  const context = new WireReplyContext();
  const deps = makeDeps({ replyContext: context });
  const sendMessage = vi.fn().mockResolvedValue("sent");
  deps.wireOutbound = createWireOutboundAdapter({ current: { manager: { sendMessage, sendAsset: vi.fn(), getUsers: vi.fn().mockResolvedValue([]) } } }, deps.logger, context);
  vi.mocked(deps.listMyActions.execute).mockRejectedValue(new Error("synthetic failure"));
  await new WireEventRouter(deps).onTextMessageReceived(TextMessage.create({ conversationId: convId, messageId: "failed-command", text: "my actions", senderId: sender }));
  expect(sendMessage.mock.calls[0][0]).toMatchObject({ text: "Something went wrong. Please try again.", quotedMessageId: "failed-command" });
  expect(context.get(convId, "failed-command")).toBeUndefined();
});

function combinedMentions(first: string, second: string) {
  const a = customMention(first);
  const b = customMention(second);
  return { ...a, text: `${a.text}\n${b.text}`, mentions: [
    ...a.mentions, ...b.mentions.map(m => ({ ...m, offset: m.offset + a.text.length + 1 })),
  ] };
}

it.each([
  makeMessage("remind me in 10 minutes to test cancellation\nremind me in 10 minutes to test snoozing"),
  combinedMentions("`remind me in 10 minutes to test cancellation`", "`remind me in 10 minutes to test snoozing`"),
  combinedMentions("decision: use Postgres", "action: review the checklist for Bob"),
  customMention("ACT-0001 done; remind me in 10 minutes to review the checklist"),
  combinedMentions("`ACT-0001` done", "`ACT-0002` done"),
  customMention("remind me in 10 minutes to review notes and then remind me in 20 minutes to review slides"),
  combinedMentions("pause", "remind me in 10 minutes to review notes"),
])("rejects multiple commands before writes, buffering or model work: $text", async message => {
  const enqueue = vi.fn();
  const deps = makeDeps({ processingQueue: { enqueue } as never, pipeline: {} as never });
  await new WireEventRouter(deps).onTextMessageReceived(message);
  expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
    "Please send one command per message. I have not run any commands from this message.",
    { replyToMessageId: message.id });
  for (const value of Object.values(deps)) {
    if (value && typeof value === "object" && "execute" in value) expect(value.execute).not.toHaveBeenCalled();
  }
  expect(deps.channelConfig.setState).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  expect(deps.messageBuffer.push).not.toHaveBeenCalled();
  expect(deps.slidingWindow.push).not.toHaveBeenCalled();
});

it.each([
  ["act-0008 done Keep This Note", "updateActionStatus", { actionId: "ACT-0008", newStatus: "done", completionNote: "Keep This Note" }],
  ["done aCt-0008", "updateActionStatus", { actionId: "ACT-0008", newStatus: "done" }],
  ["Act-0008 in progress", "updateActionStatus", { actionId: "ACT-0008", newStatus: "in_progress" }],
  ["act-0008 reassign to Alice", "reassignAction", { actionId: "ACT-0008", newAssigneeReference: "Alice" }],
  ["assign aCt-0008 to Alice", "reassignAction", { actionId: "ACT-0008", newAssigneeReference: "Alice" }],
  ["act-0008 due next Friday", "updateActionDeadline", { actionId: "ACT-0008", deadlineText: "next Friday" }],
  ["cancel rem-0008", "cancelReminder", { reminderId: "REM-0008" }],
  ["snooze rEm-0008 2 hours", "snoozeReminder", { reminderId: "REM-0008", snoozeExpression: "2 hours" }],
  ["revoke dec-0008 Keep This Reason", "revokeDecision", { decisionId: "DEC-0008", reason: "Keep This Reason" }],
  ["decision: Keep Postgres supersedes dEc-0008", "supersedeDecision", { supersedesDecisionId: "DEC-0008", newSummary: "Keep Postgres" }],
] as const)("canonicalizes only the ID prefix in %s", async (text, useCase, expected) => {
  for (const addressed of [false, true]) {
    const deps = makeDeps();
    await new WireEventRouter(deps).onTextMessageReceived(addressed ? customMention(text) : makeMessage(text));
    expect(deps[useCase].execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...expected, conversationId: convId, replyToMessageId: "msg-1",
    }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  }
});

it.each(["act0008", "act_0008", "act- 0008", "act-0008x", "act–0008"])("does not repair malformed record ID %s into a mutation", async id => {
  const deps = makeDeps();
  await new WireEventRouter(deps).onTextMessageReceived(customMention(`${id} done`));
  expect(deps.updateActionStatus.execute).not.toHaveBeenCalled();
});


it.each([
  ["remind me in 2 minutes to check the zone", "createReminder"],
  ["show reminders", "listMyReminders"],
  ["snooze rem-0001 2 minutes", "snoozeReminder"],
] as const)("passes the conversation timezone for %s", async (command, useCase) => {
  const deps = makeDeps();
  vi.mocked(deps.conversationConfig.get).mockResolvedValue({ timezone: "Europe/London" } as never);
  vi.mocked(deps.dateTimeService.parse).mockReturnValue({ value: new Date("2026-09-21T11:20:00Z"), ambiguous: false });
  await new WireEventRouter(deps).onTextMessageReceived(customMention(command));
  expect(deps[useCase].execute).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/London" }));
});

it.each([
  ["remind me in 2 minutes to check the zone", "createReminder"],
  ["show reminders", "listMyReminders"],
  ["my actions", "listMyActions"],
  ["team actions", "listTeamActions"],
  ["overdue actions", "listOverdueActions"],
  ["my tasks", "listMyActions"],
  ["team tasks", "listTeamActions"],
  ["what is the weather like?", "answerQuestion"],
] as const)("falls back to the configured default timezone for %s when the channel has no config", async (command, useCase) => {
  const deps = makeDeps({ defaultTimezone: "Europe/Berlin" } as Partial<WireEventRouterDeps>);
  vi.mocked(deps.dateTimeService.parse).mockReturnValue({ value: new Date("2026-09-21T11:20:00Z"), ambiguous: false });
  await new WireEventRouter(deps).onTextMessageReceived(customMention(command));
  expect(deps[useCase].execute).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/Berlin" }));
});

it.each([
  ["my actions", "listMyActions"],
  ["team actions", "listTeamActions"],
  ["overdue actions", "listOverdueActions"],
  ["what is the weather like?", "answerQuestion"],
] as const)("passes the conversation timezone to %s", async (command, useCase) => {
  const deps = makeDeps();
  vi.mocked(deps.conversationConfig.get).mockResolvedValue({ timezone: "Europe/London" } as never);
  await new WireEventRouter(deps).onTextMessageReceived(customMention(command));
  expect(deps[useCase].execute).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/London" }));
});

describe("WireEventRouter contract: Jira demo commands", () => {
  const jiraDeps = () => makeDeps({
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    listSupportRequests: { execute: vi.fn().mockResolvedValue(undefined) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    getIssueStatus: { execute: vi.fn().mockResolvedValue(null), projectKey: "DS" },
    conversationConfig: { get: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }), upsert: vi.fn() },
  } as unknown as Partial<WireEventRouterDeps>);

  it.each([
    ["support: My VPN drops every ten minutes", "My VPN drops every ten minutes", "My VPN drops every ten minutes"],
    ["Support:  VPN drops\nIt started after the update.", "VPN drops", "VPN drops\nIt started after the update."],
  ])("'%s' → raiseSupportRequest when the bot is mentioned", async (text, summary, description) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.raiseSupportRequest!.execute).toHaveBeenCalledWith(expect.objectContaining({
      summary, description, conversationId: convId, requesterId: sender, replyToMessageId: "msg-1", requestKind: "fault",
    }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("never raises a support request from chat that does not address the bot", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("support: my VPN drops"));
    expect(deps.raiseSupportRequest!.execute).not.toHaveBeenCalled();
  });

  it("leaves 'support:' to the existing handling when the integration is off", async () => {
    const deps = makeDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("support: my VPN drops"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId, expect.stringContaining("service desk"), expect.anything());
    // Addressed text without a command still goes to Q&A, as before the integration existed.
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ question: "support: my VPN drops" }));
  });

  it("raises a multi-line support request whose description mentions other commands, without running them", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("support: Printer broken\nACT-0005 done"));
    expect(deps.raiseSupportRequest!.execute).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Printer broken", description: "Printer broken\nACT-0005 done",
    }));
    expect(deps.updateActionStatus.execute).not.toHaveBeenCalled();
  });

  it.each([["resolve DS-6", "DS-6"], ["close ds-6.", "DS-6"]])("'%s' → resolveSupportRequest when the bot is mentioned", async (text, issueKey) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.resolveSupportRequest!.execute).toHaveBeenCalledWith({ issueKey, conversationId: convId, actorId: sender, replyToMessageId: "msg-1" });
  });

  it.each([
    ["resolve DS-6: The mirror was fitted, thanks.", "The mirror was fitted, thanks."],
    ["close ds-6 : Works again\nACT-0005 done", "Works again\nACT-0005 done"],
  ])("'%s' → resolveSupportRequest with a closing comment, never running commands inside it", async (text, comment) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.resolveSupportRequest!.execute).toHaveBeenCalledWith({
      issueKey: "DS-6", conversationId: convId, actorId: sender, comment, replyToMessageId: "msg-1",
    });
    expect(deps.updateActionStatus.execute).not.toHaveBeenCalled();
  });

  it.each([["resolve WPB-6", true], ["resolve DS-6", false]])("does not resolve '%s' (mentioned: %s) outside the addressed, configured-project form", async (text, mentioned) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(mentioned ? customMention(text) : makeMessage(text));
    expect(deps.resolveSupportRequest!.execute).not.toHaveBeenCalled();
  });

  it.each([["support requests", false], ["open support requests?", false], ["my support requests", true], ["My support request", true]])("'%s' → listSupportRequests when the bot is mentioned (own only: %s)", async (text, own) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.listSupportRequests!.execute).toHaveBeenCalledWith({
      conversationId: convId, ...(own ? { requesterId: sender } : {}), replyToMessageId: "msg-1",
    });
  });

  it.each(["support requests", "my support requests", "status of DS-42"])("needs a mention for the service-desk read '%s'", async (text) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it.each(["ACT-0004 to jira", "raise ACT-0004 in jira", "jira status of ACT-0004"])("no longer sends actions to Jira: '%s'", async (text) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(deps.raiseSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.resolveSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.listSupportRequests!.execute).not.toHaveBeenCalled();
  });

  it.each([["status of DS-42", "DS-42"], ["status of ds-42?", "DS-42"], ["jira status of DS-42", "DS-42"]])("'%s' → getIssueStatus(%s) when the bot is mentioned", async (text, reference) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.getIssueStatus!.execute).toHaveBeenCalledWith({ reference, conversationId: convId, timezone: "Europe/Berlin", replyToMessageId: "msg-1" });
  });

  it.each(["status of ACT-0004", "status of DEC-0001", "status of REM-0001", "status of KB-3", "status of WPB-1234"])("leaves '%s' to the existing handling", async (text) => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it("does not route Jira status lookups when the integration is off", async () => {
    const deps = makeDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("status of DS-42"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId, expect.stringContaining("Jira"), expect.anything());
  });

  it("does not treat the bare channel status command as a Jira lookup", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("status"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it("routes a natural status question to the Jira lookup when the bot is mentioned", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("whats the status of DS-4 in jira"));
    expect(deps.getIssueStatus!.execute).toHaveBeenCalledWith(expect.objectContaining({ reference: "DS-4", timezone: "Europe/Berlin" }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("leaves a natural status question between teammates alone", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("any update on DS-4?"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
  });

  it("sends a change request about a ticket to Q&A rather than the read-only lookup", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("please close DS-4"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.resolveSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.answerQuestion.execute).toHaveBeenCalled();
  });

  it("does not answer other projects' ticket references in ordinary chat", async () => {
    const deps = jiraDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("status of WPB-1234"));
    expect(deps.getIssueStatus!.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId, expect.stringContaining("DS project"), expect.anything());
  });

  it("keeps the previous multi-command behaviour for Jira-like text when the integration is off", async () => {
    const deps = makeDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("status of WPB-12\nACT-3 done"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", expect.anything());
  });

  it("refuses a support request that follows another command in one message", async () => {
    const deps = jiraDeps();
    const message = customMention("ACT-0005 done\nsupport: VPN drops");
    await new WireEventRouter(deps).onTextMessageReceived(message);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", { replyToMessageId: message.id });
    expect(deps.raiseSupportRequest!.execute).not.toHaveBeenCalled();
    expect(deps.updateActionStatus.execute).not.toHaveBeenCalled();
  });
});

describe("WireEventRouter contract: Jira offers and service-desk replies", () => {
  const offerDeps = (pending: boolean, handled = true, recent: unknown = null) => makeDeps({
    getIssueStatus: { execute: vi.fn().mockResolvedValue(null), projectKey: "DS" },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(undefined) },
    pendingOffers: {
      has: vi.fn().mockReturnValue(pending), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(),
      drop: vi.fn().mockReturnValue(pending ? { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" } : null),
      recentlyDropped: vi.fn().mockReturnValue(recent), forgetDropped: vi.fn(),
    },
    processingQueue: { enqueue: vi.fn() },
    pipeline: {},
    confirmOffer: { execute: vi.fn().mockResolvedValue(handled) },
    conversationConfig: { get: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }), upsert: vi.fn() },
  } as unknown as Partial<WireEventRouterDeps>);

  it("hands a reply to a pending offer to ConfirmOffer before any follow-up or Q&A handling", async () => {
    const deps = offerDeps(true);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.pendingOffers!.has).toHaveBeenCalledWith(convId, sender);
    expect(deps.confirmOffer!.execute).toHaveBeenCalledWith({
      text: "yes", conversationId: convId, requesterId: sender, requesterName: undefined, replyToMessageId: "msg-1",
    });
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("does not consult ConfirmOffer when the sender has no pending offer", async () => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.confirmOffer!.execute).not.toHaveBeenCalled();
  });

  it("continues normal routing when ConfirmOffer does not handle the message", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("ACT-0001 done"));
    expect(deps.confirmOffer!.execute).toHaveBeenCalled();
    expect(deps.updateActionStatus.execute).toHaveBeenCalledWith(expect.objectContaining({ actionId: "ACT-0001", newStatus: "done" }));
  });

  it("drops the pending offer when the requester's next message is not a yes or no", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("what is due today?"));
    expect(deps.pendingOffers!.drop).toHaveBeenCalledWith(convId, sender);
  });

  it("records a bot entry after a handled offer answer, so the offer question stops counting as the latest", async () => {
    const deps = offerDeps(true, true);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    const pushed = vi.mocked(deps.messageBuffer.push).mock.calls.map(([, message]) => message);
    expect(pushed.map((m) => m.text)).toEqual(["yes", "(Answered the offer above.)"]);
    expect(pushed[1]!.senderId).toEqual(deps.botUserId);
  });

  it("keeps the offer when it was handled by the confirmation", async () => {
    const deps = offerDeps(true, true);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.pendingOffers!.drop).not.toHaveBeenCalled();
  });

  it("hands a yes to ConfirmOffer when the sender's offer was dropped recently", async () => {
    const deps = offerDeps(false, true, { kind: "resolve", issueKey: "DS-8" });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.confirmOffer!.execute).toHaveBeenCalled();
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("passes the dropped offer to the answer path so a correction can revise it", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" },
    }));
  });

  it("sends an unmentioned correction to a passive offer to the answer path, not the pipeline", async () => {
    const deps = offerDeps(true, false);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("Shall I raise this with the service desk?");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      question: "the description should mention the office Wi-Fi",
      pendingOffer: { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" },
      amendOnly: true,
    }));
    expect(deps.processingQueue!.enqueue).not.toHaveBeenCalled();
  });

  it("passes unmentioned chat that did not revise the offer on to capture", async () => {
    const deps = offerDeps(true, false);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("I'll send the logs by Friday"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ amendOnly: true }));
    expect(deps.processingQueue!.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-1" }));
  });

  it("does not mark a mentioned correction as amend-only", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.not.objectContaining({ amendOnly: true }));
  });

  it("forgets a recently dropped offer when the requester's next message is not a yes", async () => {
    const deps = offerDeps(false, false, { kind: "resolve", issueKey: "DS-8" });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("sounds good, see you at the call"));
    expect(deps.pendingOffers!.forgetDropped).toHaveBeenCalledWith(convId, sender);
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("sends an unmentioned correction of a resolve offer with a comment to the answer path", async () => {
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue({ kind: "resolve", issueKey: "DS-8", comment: "Works again." }), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("Shall I resolve **DS-8** …?");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("say it works on both trucks"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: { kind: "resolve", issueKey: "DS-8", comment: "Works again." }, amendOnly: true,
    }));
  });

  it("sends an unmentioned message after a dropped plain resolve offer to the answer path as amend-only", async () => {
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(),
        drop: vi.fn().mockReturnValue({ kind: "resolve", issueKey: "DS-8" }), recentlyDropped: vi.fn().mockReturnValue(null), forgetDropped: vi.fn(),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    (deps.answerQuestion.execute as ReturnType<typeof vi.fn>).mockResolvedValue("");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("also add the comment 'thanks'"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: { kind: "resolve", issueKey: "DS-8" }, amendOnly: true,
    }));
    // Not a revision: the message continues to normal capture.
    expect(deps.processingQueue!.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-1" }));
  });

  it("shows the app typing while it completes a part order the requester is answering", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Mirror", description: "Need a mirror.", part: { vehicle: "truck 7", part: "left mirror" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, deliver to depot north"));
    await vi.waitFor(() => expect(vi.mocked(deps.wireOutbound.setTyping).mock.calls).toEqual([[convId, true], [convId, false]]));
  });

  it.each([["yes", true], ["no", false], ["actually three", false]])("shows typing for the confirmation %j only when it is a yes", async (text, typing) => {
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(null), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(true) },
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    await new Promise((r) => setTimeout(r, 0));
    const calls = vi.mocked(deps.wireOutbound.setTyping).mock.calls;
    if (typing) await vi.waitFor(() => expect(calls).toEqual([[convId, true], [convId, false]]));
    else expect(calls).toEqual([]);
  });

  it("completes a pending part order in code before the answer path", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Mirror", description: "Need a mirror.", part: { vehicle: "truck 7", part: "left mirror" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, deliver to depot north"));
    expect(deps.completePartOrder!.execute).toHaveBeenCalledWith({
      text: "two, deliver to depot north", conversationId: convId, requesterId: sender, pending, replyToMessageId: "msg-1",
    });
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(deps.processingQueue!.enqueue).not.toHaveBeenCalled();
  });

  it("continues to the amend path when the part order could not be completed from the message", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Mirror", description: "Need a mirror.", part: { vehicle: "truck 7" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(false) },
      processingQueue: { enqueue: vi.fn() },
      pipeline: {},
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("lunch at noon?"));
    expect(deps.completePartOrder!.execute).toHaveBeenCalled();
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({ pendingOffer: pending, amendOnly: true }));
  });

  it("does not treat a message to the bot as an answer to a part-order draft", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Mirror", description: "Need a mirror.", part: { vehicle: "truck 7" } };
    const completePartOrder = { execute: vi.fn().mockResolvedValue(true) };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder,
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("pause"));
    expect(completePartOrder.execute).not.toHaveBeenCalled();
  });

  it("records a bot entry after completing a part-order draft", async () => {
    const pending = { kind: "support", requestKind: "part", summary: "Mirror", description: "Need a mirror.", part: { vehicle: "truck 7" } };
    const deps = makeDeps({
      pendingOffers: {
        has: vi.fn().mockReturnValue(true), put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
        drop: vi.fn().mockReturnValue(pending), recentlyDropped: vi.fn().mockReturnValue(null),
      },
      confirmOffer: { execute: vi.fn().mockResolvedValue(false) },
      completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
    } as unknown as Partial<WireEventRouterDeps>);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, to depot north"));
    const pushed = vi.mocked(deps.messageBuffer.push).mock.calls.map(([, message]) => message);
    expect(pushed.map((m) => m.text)).toEqual(["two, to depot north", "(Updated the part order draft.)"]);
  });

  it("does not try to complete an offer that is not a part order", async () => {
    const completePartOrder = { execute: vi.fn() };
    const deps = offerDeps(true, false);
    Object.assign(deps, { completePartOrder });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("the description should mention the office Wi-Fi"));
    expect(completePartOrder.execute).not.toHaveBeenCalled();
  });

  it("does not pass an offer to the answer path when none was dropped", async () => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("what did we decide?"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.not.objectContaining({ pendingOffer: expect.anything() }));
  });

  it.each([
    ["reply to DS-4: The draft is attached.", "DS-4", "The draft is attached."],
    ["reply to ds-4:the draft is attached", "DS-4", "the draft is attached"],
    ["reply to DS-10: Line one\nLine two", "DS-10", "Line one\nLine two"],
  ])("routes '%s' to ReplyToServiceDesk when the bot is mentioned", async (text, reference, body) => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.replyToServiceDesk!.execute).toHaveBeenCalledWith({
      reference, body, conversationId: convId, actorId: sender, replyToMessageId: "msg-1",
    });
  });

  it("never posts a service-desk reply from chat that does not address the bot", async () => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("reply to DS-4: I think we should wait until the contract is signed"));
    expect(deps.replyToServiceDesk!.execute).not.toHaveBeenCalled();
  });

  it("drops a pending offer when the requester's next message is rejected as several commands", async () => {
    const deps = offerDeps(true, false);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("ACT-0001 done\nACT-0002 done"));
    expect(deps.pendingOffers!.drop).toHaveBeenCalledWith(convId, sender);
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", expect.anything());
  });

  it.each(["reply to WPB-12: thanks", "reply to DS-4 thanks", "reply to Bob: thanks", "reply to ACT-0010: thanks"])("does not treat '%s' as a service-desk reply", async (text) => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.replyToServiceDesk!.execute).not.toHaveBeenCalled();
  });

  it("leaves 'reply to DS-4: ...' alone when the integration is off", async () => {
    const deps = makeDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("reply to DS-4: thanks"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId, expect.stringContaining("Jira"), expect.anything());
  });

  it.each(["pause", "secure mode"])("drops pending offers when the channel is set to %s", async (command) => {
    const deps = offerDeps(false);
    await new WireEventRouter(deps).onTextMessageReceived(customMention(command));
    expect(deps.pendingOffers!.clearConversation).toHaveBeenCalledWith(convId);
  });

  it("refuses a service-desk reply combined with another command in one message", async () => {
    const deps = offerDeps(false);
    const message = customMention("reply to DS-4: done\nACT-0005 done");
    await new WireEventRouter(deps).onTextMessageReceived(message);
    expect(deps.replyToServiceDesk!.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId,
      "Please send one command per message. I have not run any commands from this message.", { replyToMessageId: message.id });
  });
});

describe("WireEventRouter contract: channel timezone", () => {
  const tzDeps = () => makeDeps({ setChannelTimezone: { execute: vi.fn().mockResolvedValue(undefined) } } as unknown as Partial<WireEventRouterDeps>);

  it.each([
    ["timezone Europe/Berlin", "Europe/Berlin"],
    ["set the timezone to america/new_york", "america/new_york"],
    ["time zone UTC.", "UTC"],
    ["change our time zone to Europe/London", "Europe/London"],
    ["set this channel's timezone Europe/Paris", "Europe/Paris"],
    ["change the channel's timezone to America/Argentina/Buenos_Aires", "America/Argentina/Buenos_Aires"],
    ["timezone: Asia/Tokyo", "Asia/Tokyo"],
    ["timezone to Europe/Berlin!", "Europe/Berlin"],
    ["timezone Etc/GMT+1", "Etc/GMT+1"],
  ])("'%s' → setChannelTimezone(%s) when the bot is mentioned", async (text, timezone) => {
    const deps = tzDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.setChannelTimezone!.execute).toHaveBeenCalledWith(expect.objectContaining({ conversationId: convId, actorId: sender, timezone }));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("shows the current timezone for a bare 'timezone'", async () => {
    const deps = tzDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("timezone?"));
    expect(deps.setChannelTimezone!.execute).toHaveBeenCalledWith(expect.not.objectContaining({ timezone: expect.anything() }));
  });

  it.each(["timezone differences?", "timezone of the customer is different", "time zone +01:00"])(
    "lets '%s' continue to normal routing", async (text) => {
      const deps = tzDeps();
      await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
      expect(deps.setChannelTimezone!.execute).not.toHaveBeenCalled();
      expect(deps.answerQuestion.execute).toHaveBeenCalled();
    });

  it("never changes the timezone from chat that does not mention the bot", async () => {
    const deps = tzDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("timezone Europe/Berlin"));
    expect(deps.setChannelTimezone!.execute).not.toHaveBeenCalled();
  });
});

describe("WireEventRouter contract: pause means mentions only", () => {
  const other: QualifiedId = { id: "user-2", domain: "wire.com" };
  const fromOther = (text: string) => ({ ...makeMessage(text, "msg-2"), sender: other });
  const faultOffer = { kind: "support", requestKind: "fault", summary: "VPN drops", description: "VPN drops" };
  const partDraft = { kind: "support", requestKind: "part", summary: "Mirror", description: "Need a mirror.", part: { vehicle: "truck 7" } };

  /** A channel whose stored state is paused; `offer` is the pending offer of `sender` only. */
  const pausedDeps = (offer: unknown = null, opts: { handled?: boolean; recent?: unknown } = {}) => makeDeps({
    channelConfig: {
      get: vi.fn().mockResolvedValue({ state: "paused", secureRanges: [], timezone: "UTC", locale: "en", organisationId: "wire.com", channelId: "conv-1@wire.com" }),
      upsert: vi.fn(), setState: vi.fn(), setTimezone: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
    },
    processingQueue: { enqueue: vi.fn(), cancelChannel: vi.fn() },
    pipeline: {},
    pendingOffers: {
      has: vi.fn((_c: QualifiedId, requester: QualifiedId) => offer !== null && requester.id === sender.id),
      put: vi.fn(), take: vi.fn(), clearConversation: vi.fn(), forgetDropped: vi.fn(),
      drop: vi.fn((_c: QualifiedId, requester: QualifiedId) => (requester.id === sender.id ? offer : null)),
      recentlyDropped: vi.fn((_c: QualifiedId, requester: QualifiedId) => (requester.id === sender.id ? opts.recent ?? null : null)),
    },
    confirmOffer: { execute: vi.fn().mockResolvedValue(opts.handled ?? false) },
    completePartOrder: { execute: vi.fn().mockResolvedValue(true) },
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    listSupportRequests: { execute: vi.fn().mockResolvedValue(undefined) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(undefined) },
    getIssueStatus: { execute: vi.fn().mockResolvedValue(null), projectKey: "DS" },
    statusCommand: { execute: vi.fn().mockResolvedValue(undefined) },
    setChannelTimezone: { execute: vi.fn().mockResolvedValue(undefined) },
    catchMeUpCommand: { execute: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Partial<WireEventRouterDeps>);

  const expectNothingKept = (deps: WireEventRouterDeps) => {
    expect(deps.messageBuffer.push).not.toHaveBeenCalled();
    expect(deps.slidingWindow.push).not.toHaveBeenCalled();
    expect(deps.processingQueue!.enqueue).not.toHaveBeenCalled();
  };

  it("ignores ordinary chat: no capture, no reactions, no offers, no reply", async () => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("my VPN keeps dropping, I'll send the report tomorrow"));
    expectNothingKept(deps);
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendReaction).not.toHaveBeenCalled();
  });

  it.each([
    ["decision: use Postgres", "logDecision"],
    ["action: review the checklist", "createActionFromExplicit"],
    ["remind me in 2 hours to check the build", "createReminder"],
    ["ACT-0001 done", "updateActionStatus"],
    ["my actions", "listMyActions"],
  ] as const)("does not run the unmentioned command '%s'", async (text, useCase) => {
    const deps = pausedDeps();
    vi.mocked(deps.dateTimeService.parse).mockReturnValue({ value: new Date() } as never);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(deps[useCase].execute).not.toHaveBeenCalled();
    expectNothingKept(deps);
  });

  it("does not count the bot's name typed without a real mention", async () => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("@Wire Team Bot decision: use Postgres"));
    expect(deps.logDecision.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });

  it("answers a mentioned question without conversation context and keeps nothing", async () => {
    const deps = pausedDeps();
    vi.mocked(deps.answerQuestion.execute).mockResolvedValue("We decided on Postgres.");
    vi.mocked(deps.messageBuffer.getLastN).mockReturnValue([
      { messageId: "old", senderId: other, senderName: "Bob", text: "EXCLUDED_MARKER", timestamp: new Date() },
    ]);
    await new WireEventRouter(deps).onTextMessageReceived(customMention("what did we decide about the database?"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      question: "what did we decide about the database?", conversationContext: [], requester: expect.objectContaining({ id: sender.id }),
    }));
    expect(JSON.stringify(vi.mocked(deps.answerQuestion.execute).mock.calls)).not.toContain("EXCLUDED_MARKER");
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalledWith(convId, expect.stringContaining("standing by"), expect.anything());
    expectNothingKept(deps);
  });

  it("carries out a mentioned record command", async () => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("decision: use Postgres"));
    expect(deps.logDecision.execute).toHaveBeenCalledWith(expect.objectContaining({ summary: "use Postgres" }));
    expectNothingKept(deps);
  });

  it.each([
    ["support: My VPN drops", "raiseSupportRequest"],
    ["status of DS-4", "getIssueStatus"],
    ["reply to DS-4: thanks", "replyToServiceDesk"],
    ["resolve DS-4", "resolveSupportRequest"],
    ["support requests", "listSupportRequests"],
  ] as const)("carries out the mentioned support command '%s'", async (text, useCase) => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect((deps[useCase] as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledOnce();
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expectNothingKept(deps);
  });

  it.each([
    ["status", "statusCommand"],
    ["timezone Europe/Berlin", "setChannelTimezone"],
    ["catch me up", "catchMeUpCommand"],
  ] as const)("carries out the mentioned channel command '%s'", async (text, useCase) => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect((deps[useCase] as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledOnce();
    expectNothingKept(deps);
  });

  it("saves a mentioned channel purpose and keeps the paused state", async () => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("context: truck support"));
    expect(deps.channelConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({ purpose: "truck support", state: "paused" }));
  });

  it.each([
    ["resume", "active"],
    ["secure mode", "secure"],
  ])("changes state on a mentioned '%s'", async (text, state) => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention(text));
    expect(deps.channelConfig.setState).toHaveBeenCalledWith("conv-1@wire.com", state, sender.id, expect.any(Date));
  });

  it("says it is already paused on a mentioned 'pause'", async () => {
    const deps = pausedDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("pause"));
    expect(deps.channelConfig.setState).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringContaining("already paused"), expect.anything());
  });

  it("confirms the pause with the mentions-only behaviour", async () => {
    const deps = makeDeps();
    await new WireEventRouter(deps).onTextMessageReceived(customMention("pause"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringContaining("still respond when mentioned"), expect.anything());
  });

  it("does not take an unmentioned message as a follow-up to the bot's question", async () => {
    const deps = pausedDeps();
    vi.mocked(deps.messageBuffer.getLastN).mockReturnValue([
      { messageId: "bot-1", senderId: deps.botUserId, senderName: "Wire Team Bot", text: "Which truck is it?", timestamp: new Date() },
    ]);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("truck 7"));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expectNothingKept(deps);
  });

  // Decision 1: answers to the bot's own offer or part-order question need no mention.
  it.each(["yes", "no"])("hands the requester's unmentioned '%s' to the pending offer without buffering", async (text) => {
    const deps = pausedDeps(faultOffer, { handled: true });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage(text));
    expect(deps.confirmOffer!.execute).toHaveBeenCalledWith(expect.objectContaining({ text, requesterId: sender }));
    expectNothingKept(deps);
  });

  it("answers the requester's unmentioned yes after the offer was dropped recently", async () => {
    const deps = pausedDeps(null, { handled: true, recent: faultOffer });
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("yes"));
    expect(deps.confirmOffer!.execute).toHaveBeenCalled();
  });

  it("does not let another member answer the requester's offer", async () => {
    const deps = pausedDeps(faultOffer, { handled: true });
    await new WireEventRouter(deps).onTextMessageReceived(fromOther("yes"));
    expect(deps.confirmOffer!.execute).not.toHaveBeenCalled();
    expectNothingKept(deps);
  });

  it("merges the requester's unmentioned details into a part-order draft without buffering", async () => {
    const deps = pausedDeps(partDraft);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("two, to depot north"));
    expect(deps.completePartOrder!.execute).toHaveBeenCalledWith(expect.objectContaining({ text: "two, to depot north", pending: partDraft }));
    expectNothingKept(deps);
  });

  it("sends the requester's unmentioned correction to the answer path without context", async () => {
    const deps = pausedDeps(faultOffer);
    vi.mocked(deps.answerQuestion.execute).mockResolvedValue("Shall I raise this with the service desk?");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("the description should mention the office Wi-Fi"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(expect.objectContaining({
      pendingOffer: faultOffer, amendOnly: true, conversationContext: [],
    }));
    expectNothingKept(deps);
  });

  it("does not capture the requester's unmentioned chat that did not revise the offer", async () => {
    const deps = pausedDeps(faultOffer);
    vi.mocked(deps.answerQuestion.execute).mockResolvedValue("");
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("lunch at noon?"));
    expectNothingKept(deps);
  });

  it("does not run an unmentioned command from the requester that displaced the offer", async () => {
    const deps = pausedDeps(faultOffer);
    await new WireEventRouter(deps).onTextMessageReceived(makeMessage("ACT-0001 done"));
    expect(deps.pendingOffers!.drop).toHaveBeenCalledWith(convId, sender);
    expect(deps.updateActionStatus.execute).not.toHaveBeenCalled();
  });
});

describe("WireEventRouter contract: local fail-closed block", () => {
  it("answers nothing but resume and secure mode after the state could not be read", async () => {
    const deps = makeDeps();
    vi.mocked(deps.channelConfig.get).mockRejectedValue(new Error("DB down"));
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(customMention("what did we decide?"));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(convId, expect.stringContaining("standing by"), expect.anything());
    expect(deps.messageBuffer.push).not.toHaveBeenCalled();
  });

  it("does not answer mentions after a failed secure mode write", async () => {
    const deps = makeDeps();
    vi.mocked(deps.channelConfig.setState).mockRejectedValue(new Error("DB down"));
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(customMention("secure mode"));
    await router.onTextMessageReceived(customMention("decision: EXCLUDED_MARKER"));
    await router.onTextMessageReceived(customMention("what did we decide?"));
    expect(deps.logDecision.execute).not.toHaveBeenCalled();
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });
});
