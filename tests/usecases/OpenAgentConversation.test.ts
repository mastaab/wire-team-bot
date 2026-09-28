import { describe, it, expect, vi } from "vitest";
import {
  OpenAgentConversation, agentGroupName, AGENT_GROUP_NAME_MAX,
} from "../../src/application/usecases/jira/OpenAgentConversation";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { WireUserRef } from "../../src/application/ports/WireConversationPort";
import {
  alice, convId, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeWire, sentRefFor,
} from "./supportRequestFakes";

const T0 = new Date("2026-09-28T12:00:00Z");
const LAST_MESSAGE = { messageId: "raised-1", sha256: "a".repeat(64) };
const agentId: QualifiedId = { id: "agent-1", domain: "wire.com" };
const groupId: QualifiedId = { id: "group-1", domain: "wire.com" };
const AGENT_NAME = "Petra Desk";

class NamedError extends Error {
  constructor(name: string) {
    super("secret detail that must not be logged");
    this.name = name;
  }
}

function makeConversations(agent: WireUserRef | null = { id: agentId, name: AGENT_NAME }) {
  return {
    findUserByHandle: vi.fn(async (_handle: string) => agent),
    createGroup: vi.fn(async (_name: string, _members: readonly QualifiedId[]) => groupId),
    makeAdmin: vi.fn(async (_c: QualifiedId, _u: QualifiedId) => undefined),
    leave: vi.fn(async (_c: QualifiedId) => undefined),
  };
}

function setup(options: { agent?: WireUserRef | null; request?: Parameters<typeof makeRequest>[0] } = {}) {
  const request = makeRequest({ lastSeenReplyAt: T0, lastMessage: LAST_MESSAGE, ...options.request });
  const requests = makeRequests([request]);
  const conversations = makeConversations(options.agent === undefined ? { id: agentId, name: AGENT_NAME } : options.agent);
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new OpenAgentConversation(requests, conversations, wire, audit, logger, () => T0);
  const run = () => useCase.execute({ request, agentHandle: "petra.desk" });
  return { request, requests, conversations, wire, sent, audit, logger, run };
}

const INTRO = "**DS-6** VPN drops every ten minutes\n\n"
  + "Petra Desk from the service desk has picked up this request. You can talk here directly; "
  + "this conversation is not recorded in the ticket, and I'm leaving it now.";
const NOTICE = "**DS-6** VPN drops every ten minutes\n"
  + "Contact with the responsible support agent (Petra Desk) has been initiated: they and Alice now have a direct conversation.";

/** Names, handles and conversation IDs that must never reach logs or the audit. */
function expectNoPrivateData(text: string) {
  for (const value of [AGENT_NAME, "Alice", "petra.desk", "agent-1", "group-1", "conv-1", "user-1", "secret detail"]) {
    expect(text).not.toContain(value);
  }
}

describe("OpenAgentConversation: opening", () => {
  it("resolves the agent, claims, creates the group, introduces, hands over, leaves and tells the channel", async () => {
    const { run, requests, conversations, wire, sent } = setup();

    expect(await run()).toBe("opened");

    expect(conversations.findUserByHandle).toHaveBeenCalledWith("petra.desk");
    expect(requests.markAgentConversation).toHaveBeenCalledWith("DS-6", T0);
    expect(conversations.createGroup).toHaveBeenCalledWith("DS-6 VPN drops every ten minutes", [alice, agentId]);
    expect(sent).toEqual([INTRO, NOTICE]);
    expect(wire.sendPlainText.mock.calls[0][0]).toEqual(groupId);
    expect(wire.sendPlainText.mock.calls[0][2]).toBeUndefined();
    expect(wire.sendPlainText.mock.calls[1][0]).toEqual(convId);
    expect(wire.sendPlainText.mock.calls[1][2]).toEqual({ quote: LAST_MESSAGE });
    expect(conversations.makeAdmin.mock.calls).toEqual([[groupId, alice], [groupId, agentId]]);
    expect(conversations.leave).toHaveBeenCalledWith(groupId);
    expect(requests.setLastMessage).toHaveBeenCalledWith("DS-6", sentRefFor(2));
  });

  it("does things in order: claim, group, intro, admins, leave, notice", async () => {
    const { run, requests, conversations, wire } = setup();
    await run();
    const order = (fn: { mock: { invocationCallOrder: number[] } }, i = 0) => fn.mock.invocationCallOrder[i];
    const steps = [
      order(requests.markAgentConversation), order(conversations.createGroup), order(wire.sendPlainText, 0),
      order(conversations.makeAdmin, 0), order(conversations.makeAdmin, 1), order(conversations.leave),
      order(wire.sendPlainText, 1),
    ];
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("audits an update of the request without names or IDs", async () => {
    const { run, audit } = setup();
    await run();
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith({
      timestamp: T0,
      actorId: { id: "wire-team-bot", domain: "wire.com" },
      conversationId: convId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: "DS-6",
      details: { agentConversation: "opened" },
    });
    expect(JSON.stringify(audit.append.mock.calls[0][0].details)).toBe('{"agentConversation":"opened"}');
  });

  it("posts the notice without a quote when no last message is stored", async () => {
    const { run, wire } = setup({ request: { lastMessage: undefined } });
    await run();
    expect(wire.sendPlainText.mock.calls[1][2]).toBeUndefined();
  });

  it("names the requester generically when no name was stored", async () => {
    const { run, sent } = setup({ request: { requesterName: "  " } });
    await run();
    expect(sent[1]).toContain("they and the requester now have a direct conversation.");
  });

  it("stores nothing as the last message when the transport returns no reference", async () => {
    const { run, wire, requests } = setup();
    wire.sendPlainText.mockResolvedValue(undefined);
    expect(await run()).toBe("opened");
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });
});

describe("OpenAgentConversation: group name", () => {
  it("collapses whitespace", () => {
    expect(agentGroupName("DS-6", "  VPN\n drops\t\tagain ")).toBe("DS-6 VPN drops again");
  });

  it("keeps a name of exactly the limit", () => {
    const summary = "x".repeat(AGENT_GROUP_NAME_MAX - "DS-6 ".length);
    expect(agentGroupName("DS-6", summary)).toBe(`DS-6 ${summary}`);
  });

  it("cuts a longer name to the limit, ending in ...", () => {
    const name = agentGroupName("DS-25", "The refrigeration unit on trailer 4471 stops cooling after about twenty minutes on the motorway");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("DS-25 The refrigeration unit")).toBe(true);
    expect(name.endsWith("...")).toBe(true);
  });

  it("passes the cut name to createGroup", async () => {
    const { run, conversations } = setup({ request: { summary: "word ".repeat(40) } });
    await run();
    const name = conversations.createGroup.mock.calls[0][0];
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("...")).toBe(true);
    expect(name).not.toContain("  ");
  });
});

describe("OpenAgentConversation: skipped", () => {
  it("skips an unresolved handle without claiming", async () => {
    const { run, requests, conversations, wire, audit, logger } = setup({ agent: null });
    expect(await run()).toBe("skipped");
    expect(requests.markAgentConversation).not.toHaveBeenCalled();
    expect(conversations.createGroup).not.toHaveBeenCalled();
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expectNoPrivateData(loggedText(logger));
  });

  it("skips when the agent is the requester (both halves of the ID match)", async () => {
    const { run, requests, conversations, wire } = setup({ agent: { id: { ...alice }, name: "Alice" } });
    expect(await run()).toBe("skipped");
    expect(requests.markAgentConversation).not.toHaveBeenCalled();
    expect(conversations.createGroup).not.toHaveBeenCalled();
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("does not treat the same ID on another domain as the requester", async () => {
    const { run } = setup({ agent: { id: { id: alice.id, domain: "other.example" }, name: AGENT_NAME } });
    expect(await run()).toBe("opened");
  });

  it("skips when the claim finds it already opened", async () => {
    const { run, requests, conversations, wire, audit } = setup();
    requests.markAgentConversation.mockResolvedValue(false);
    expect(await run()).toBe("skipped");
    expect(conversations.createGroup).not.toHaveBeenCalled();
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe("OpenAgentConversation: failures", () => {
  it("fails when the group cannot be created, logging the error name and key only", async () => {
    const { run, conversations, wire, audit, logger } = setup();
    conversations.createGroup.mockRejectedValue(new NamedError("ConversationCreateError"));
    expect(await run()).toBe("failed");
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(conversations.leave).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "ConversationCreateError" });
    expectNoPrivateData(loggedText(logger));
  });

  it("fails when resolving the handle throws", async () => {
    const { run, conversations, requests } = setup();
    conversations.findUserByHandle.mockRejectedValue(new NamedError("SearchError"));
    expect(await run()).toBe("failed");
    expect(requests.markAgentConversation).not.toHaveBeenCalled();
  });

  it("fails when the claim throws", async () => {
    const { run, conversations, requests } = setup();
    requests.markAgentConversation.mockRejectedValue(new NamedError("DbError"));
    expect(await run()).toBe("failed");
    expect(conversations.createGroup).not.toHaveBeenCalled();
  });

  it("continues after a failed introduction", async () => {
    const { run, wire, conversations, logger } = setup();
    wire.sendPlainText.mockRejectedValueOnce(new NamedError("SendError"));
    expect(await run()).toBe("opened");
    expect(conversations.makeAdmin).toHaveBeenCalledTimes(2);
    expect(conversations.leave).toHaveBeenCalled();
    expect(wire.sendPlainText).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "SendError" });
  });

  it("logs each failed role change and leaves anyway", async () => {
    const { run, conversations, logger, audit } = setup();
    conversations.makeAdmin.mockRejectedValue(new NamedError("RoleError"));
    expect(await run()).toBe("opened");
    expect(conversations.makeAdmin).toHaveBeenCalledTimes(2);
    expect(conversations.leave).toHaveBeenCalledWith(groupId);
    expect(logger.warn.mock.calls.filter((call) => call[1]?.err === "RoleError")).toHaveLength(2);
    expect(audit.append).toHaveBeenCalled();
    expectNoPrivateData(loggedText(logger));
  });

  it("makes the agent admin when the requester's role change fails", async () => {
    const { run, conversations } = setup();
    conversations.makeAdmin.mockRejectedValueOnce(new NamedError("RoleError"));
    await run();
    expect(conversations.makeAdmin).toHaveBeenLastCalledWith(groupId, agentId);
  });

  it("is still opened when leaving fails, and still tells the channel", async () => {
    const { run, conversations, sent, logger, audit } = setup();
    conversations.leave.mockRejectedValue(new NamedError("LeaveError"));
    expect(await run()).toBe("opened");
    expect(sent).toEqual([INTRO, NOTICE]);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "LeaveError" });
    expect(audit.append).toHaveBeenCalled();
  });

  it("is still opened when the notice cannot be sent", async () => {
    const { run, wire, requests, audit } = setup();
    wire.sendPlainText.mockResolvedValueOnce(sentRefFor(1)).mockRejectedValueOnce(new NamedError("SendError"));
    expect(await run()).toBe("opened");
    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalled();
  });

  it("is still opened when the audit fails", async () => {
    const { run, audit, logger } = setup();
    audit.append.mockRejectedValue(new NamedError("AuditError"));
    expect(await run()).toBe("opened");
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { err: "AuditError" });
  });

  it("logs no names, handles or IDs across every failing step", async () => {
    const { run, wire, conversations, requests, logger } = setup();
    wire.sendPlainText.mockRejectedValue(new NamedError("SendError"));
    conversations.makeAdmin.mockRejectedValue(new NamedError("RoleError"));
    conversations.leave.mockRejectedValue(new NamedError("LeaveError"));
    requests.setLastMessage.mockRejectedValue(new NamedError("DbError"));
    await run();
    expectNoPrivateData(loggedText(logger));
  });
});
