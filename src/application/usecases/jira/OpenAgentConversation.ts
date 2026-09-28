import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { sameQualifiedId, type QualifiedId } from "../../../domain/ids/QualifiedId";
import type { WireConversationPort, WireUserRef } from "../../ports/WireConversationPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { rememberLastMessage } from "./supportRequestMarkers";
import { appendAuditSafely, botActor } from "./supportRequestStatus";

const SOURCE = "OpenAgentConversation";

/** Longest group name; a longer one is cut and ends in "...". */
export const AGENT_GROUP_NAME_MAX = 64;

/** Contract: see PLAN.md §6 "Direct conversation with the desk agent". */
export interface OpenAgentConversationInput {
  /** The request as just re-read by the watch; open, in an active channel, without a conversation yet. */
  request: SupportRequest;
  /** Wire handle of the newly assigned agent, from the setting. */
  agentHandle: string;
}

export type OpenAgentConversationOutcome = "opened" | "skipped" | "failed";

/**
 * Opens the direct conversation for a request whose mapped agent was just assigned: resolves the
 * agent's handle, claims the request with `markAgentConversation` (false: already opened,
 * "skipped"), creates the group `<KEY> <summary>` with requester and agent, posts the intro
 * there, makes both admins (a failure is logged, the bot leaves anyway), leaves, then tells the
 * original channel as a reply to the request's last message and stores that reply as the last
 * message. Audited as an update of the request (`agentConversation: "opened"`), no names or IDs.
 * The agent being the requester, or a handle that does not resolve, is "skipped". A failure
 * before the group exists is "failed" and releases nothing (the claim stays, so it is not
 * retried in a loop); logs carry error names and the key only.
 */
export class OpenAgentConversation {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly conversations: WireConversationPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: OpenAgentConversationInput): Promise<OpenAgentConversationOutcome> {
    const { request, agentHandle } = input;
    const key = request.key;

    let agent: WireUserRef | null;
    try {
      agent = await this.conversations.findUserByHandle(agentHandle);
    } catch (err) {
      this.logger?.error(`${SOURCE}: resolving the agent failed`, { key, err: errorName(err) });
      return "failed";
    }
    if (!agent) {
      this.logger?.warn(`${SOURCE}: the agent's handle did not resolve`, { key });
      return "skipped";
    }
    if (sameQualifiedId(agent.id, request.requesterId)) {
      this.logger?.info(`${SOURCE}: the agent is the requester`, { key });
      return "skipped";
    }

    const now = this.now();
    let claimed: boolean;
    try {
      claimed = await this.requests.markAgentConversation(key, now);
    } catch (err) {
      this.logger?.error(`${SOURCE}: claiming the request failed`, { key, err: errorName(err) });
      return "failed";
    }
    if (!claimed) return "skipped";

    let groupId: QualifiedId;
    try {
      groupId = await this.conversations.createGroup(agentGroupName(key, request.summary), [request.requesterId, agent.id]);
    } catch (err) {
      this.logger?.error(`${SOURCE}: creating the group failed`, { key, err: errorName(err) });
      return "failed";
    }

    const heading = `**${key}** ${request.summary}`;
    const agentName = agent.name.trim();
    const intro = `${agentName || "Someone"} from the service desk has picked up this request. `
      + "You can talk here directly; this conversation is not recorded in the ticket, and I'm leaving it now.";
    try {
      await this.wireOutbound.sendPlainText(groupId, `${heading}\n\n${intro}`);
    } catch (err) {
      this.logger?.warn(`${SOURCE}: sending the introduction failed`, { key, err: errorName(err) });
    }

    const admins: Array<[string, QualifiedId]> = [["requester", request.requesterId], ["agent", agent.id]];
    for (const [role, userId] of admins) {
      try {
        await this.conversations.makeAdmin(groupId, userId);
      } catch (err) {
        this.logger?.warn(`${SOURCE}: making the ${role} an admin failed`, { key, err: errorName(err) });
      }
    }
    try {
      await this.conversations.leave(groupId);
    } catch (err) {
      this.logger?.error(`${SOURCE}: leaving the group failed`, { key, err: errorName(err) });
    }

    const requesterName = request.requesterName.trim() || "the requester";
    const agentPart = agentName ? ` (${agentName})` : "";
    const notice = `Contact with the responsible support agent${agentPart} has been initiated: `
      + `they and ${requesterName} now have a direct conversation.`;
    try {
      const ref = await this.wireOutbound.sendPlainText(
        request.conversationId, `${heading}\n${notice}`, request.lastMessage ? { quote: request.lastMessage } : undefined,
      );
      await rememberLastMessage(this.requests, key, ref, SOURCE, this.logger);
    } catch (err) {
      this.logger?.warn(`${SOURCE}: sending the notice failed`, { key, err: errorName(err) });
    }

    await appendAuditSafely(this.auditLog, {
      timestamp: now,
      actorId: botActor(request.conversationId),
      conversationId: request.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: key,
      details: { agentConversation: "opened" },
    }, SOURCE, this.logger);
    return "opened";
  }
}

/** `<KEY> <summary>` with whitespace collapsed, cut to `AGENT_GROUP_NAME_MAX` characters ending in "...". */
export function agentGroupName(key: string, summary: string): string {
  const name = `${key} ${summary}`.replace(/\s+/g, " ").trim();
  if (name.length <= AGENT_GROUP_NAME_MAX) return name;
  return `${name.slice(0, AGENT_GROUP_NAME_MAX - 3).trimEnd()}...`;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
