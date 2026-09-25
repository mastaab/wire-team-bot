import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject, jiraKeyFromLinks, toJiraLink } from "../../../domain/ids/jiraLink";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { REPLY_BODY_MAX } from "../../services/offers";

export interface ReplyToServiceDeskInput {
  /** Either an action ID (ACT-NNNN) or a tracker key. */
  reference: string;
  /** Reply text. Sent to the ticket; never stored, logged or audited. */
  body: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

type Reply = (text: string) => Promise<void>;

interface LinkedTicket {
  key: string;
  actionId: string;
}

const ACTION_ID_RE = /^ACT-\d+$/;

/**
 * Sends one customer-facing reply to a ticket linked from this conversation. The reply
 * carries a footer naming the action, never the requester: the bot speaks for the team.
 */
export class ReplyToServiceDesk {
  constructor(
    private readonly actions: ActionRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** True when the reply was sent. Exactly one Wire message is sent either way. */
  async execute(input: ReplyToServiceDeskInput): Promise<boolean> {
    const reply: Reply = text =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const reference = input.reference.trim().toUpperCase();
    const ticket = ACTION_ID_RE.test(reference)
      ? await this.ticketFromAction(reference, input.conversationId, reply)
      : await this.ticketFromIssueReference(reference, input.conversationId, reply);
    if (!ticket) return false;

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
      await this.tracker.addCustomerReply(ticket.key, `${body}\n\nSent from Wire (${ticket.actionId}).`);
    } catch (err) {
      this.logger?.warn("ReplyToServiceDesk: addCustomerReply failed", trackerErrorFields(err));
      await reply(`I'm afraid I couldn't send the reply to **${ticket.key}** just now.`);
      return false;
    }

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "JiraComment",
      entityId: ticket.key,
      details: { actionId: ticket.actionId },
    });
    await reply(`Sent your reply to **${ticket.key}** in Jira.`);
    return true;
  }

  private async ticketFromAction(actionId: string, conversationId: QualifiedId, reply: Reply): Promise<LinkedTicket | null> {
    const action = await this.actions.findById(actionId);
    if (!action || action.deleted || !sameQualifiedId(action.conversationId, conversationId)) {
      await reply(`I'm afraid I can't find **${actionId}** in this conversation.`);
      return null;
    }
    const key = jiraKeyFromLinks(action.linkedIds);
    if (!key) {
      await reply(`**${action.id}** isn't linked to a Jira ticket yet. Use \`${action.id} to jira\` to raise one.`);
      return null;
    }
    if (!isKeyInProject(key, this.tracker.projectKey)) {
      await reply(`I'm afraid **${action.id}** is linked to **${key}**, which is outside the ${this.tracker.projectKey} project I can reply to.`);
      return null;
    }
    return { key, actionId: action.id };
  }

  /** A bare key must be in the configured project and linked from an action in this conversation. */
  private async ticketFromIssueReference(key: string, conversationId: QualifiedId, reply: Reply): Promise<LinkedTicket | null> {
    if (!isKeyInProject(key, this.tracker.projectKey)) {
      await reply(`I'm afraid I can only reply to tickets in the ${this.tracker.projectKey} project.`);
      return null;
    }
    const link = toJiraLink(key);
    const candidates = await this.actions.query({ conversationId, linkedIdsHas: link, limit: 20 });
    const linking = candidates.find(a =>
      !a.deleted && sameQualifiedId(a.conversationId, conversationId) && a.linkedIds.includes(link));
    if (!linking) {
      await reply(`I'm afraid **${key}** isn't linked to an action in this conversation.`);
      return null;
    }
    return { key, actionId: linking.id };
  }
}
