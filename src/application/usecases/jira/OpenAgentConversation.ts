import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { WireConversationPort } from "../../ports/WireConversationPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

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

  async execute(_input: OpenAgentConversationInput): Promise<OpenAgentConversationOutcome> {
    throw new Error("OpenAgentConversation.execute is not implemented yet");
  }
}
