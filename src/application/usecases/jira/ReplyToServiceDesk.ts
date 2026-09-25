import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { IssueTrackerError, trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { REPLY_BODY_MAX } from "../../services/offers";
import { REPLY_FOOTER } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { notInConversation } from "./supportRequestStatus";

export interface ReplyToServiceDeskInput {
  /** A tracker key, e.g. "DS-6". */
  reference: string;
  /** Reply text. Sent to the ticket; never stored, logged or audited. */
  body: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

/**
 * Only a 4xx response means Jira refused the reply. A timeout, network error, 5xx or
 * unexpected response may follow an accepted write, so it must not invite a resend.
 */
function wasRejected(err: unknown): boolean {
  return err instanceof IssueTrackerError && err.status !== undefined && err.status >= 400 && err.status < 500;
}

/**
 * Sends one customer-facing reply to a support request of this conversation. The reply
 * carries a footer saying it came from Wire; the bot speaks for the team.
 */
export class ReplyToServiceDesk {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** True when the reply was sent. Exactly one Wire message is sent either way. */
  async execute(input: ReplyToServiceDeskInput): Promise<boolean> {
    const reply = (text: string): Promise<void> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.reference, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.reference));
      return false;
    }
    const key = request.key;

    const body = input.body.trim();
    if (!body) {
      await reply("I'm afraid there is nothing to send.");
      return false;
    }
    if (body.length > REPLY_BODY_MAX) {
      await reply(`I'm afraid that reply is too long for Jira; please keep it under ${REPLY_BODY_MAX} characters.`);
      return false;
    }

    try {
      await this.tracker.addCustomerReply(key, `${body}\n\n${REPLY_FOOTER}`);
    } catch (err) {
      this.logger?.warn("ReplyToServiceDesk: addCustomerReply failed", trackerErrorFields(err));
      await reply(wasRejected(err)
        ? `I'm afraid I couldn't send the reply to **${key}** just now.`
        : `I'm afraid I couldn't confirm that the reply reached **${key}**. Please check the ticket before sending it again.`);
      return false;
    }

    // The reply is public in Jira now, so an audit failure must not suggest otherwise.
    try {
      await this.auditLog.append({
        timestamp: new Date(),
        actorId: input.actorId,
        conversationId: input.conversationId,
        action: "entity_created",
        entityType: "JiraComment",
        entityId: key,
        details: { supportRequest: key },
      });
    } catch (err) {
      this.logger?.error("ReplyToServiceDesk: audit append failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
    await reply(`Sent your reply to **${key}** in Jira.`);
    return true;
  }
}
