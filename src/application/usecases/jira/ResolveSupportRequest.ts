import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogEntry, AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatResolution } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { appendAuditSafely, botActor, notInConversation, refreshStatusCategory } from "./supportRequestStatus";

export interface ResolveSupportRequestInput {
  issueKey: string;
  conversationId: QualifiedId;
  /** Any member of the channel may resolve; the audit entry records who did. */
  actorId: QualifiedId;
  /**
   * A closing comment, sent first as a customer-facing reply (footer "Sent from Wire.",
   * audited). If it is refused or its delivery cannot be confirmed, the request is not resolved.
   */
  comment?: string;
  replyToMessageId?: string;
}

/**
 * Moves a support request of this conversation to done with the service desk, stores the
 * resulting category and reports the SLA outcome. A request last known as done is read live
 * first, since the desk may have reopened it. Every attempt that reaches the tracker is
 * audited with the actor, because some transitions may apply before a failure.
 */
export class ResolveSupportRequest {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** The final snapshot, or null when nothing was resolved. Exactly one Wire message is sent. */
  async execute(input: ResolveSupportRequestInput): Promise<IssueSnapshot | null> {
    const reply = (text: string): Promise<void> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.issueKey, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.issueKey));
      return null;
    }
    const key = request.key;
    let current = request;
    if (request.statusCategory === "done") {
      // The desk may have reopened the ticket since, so the last known category is checked live.
      let live: IssueSnapshot | null;
      try {
        live = await this.tracker.getIssue(key);
      } catch (err) {
        this.logger?.warn("ResolveSupportRequest: getIssue failed", { key, ...trackerErrorFields(err) });
        live = null;
      }
      if (!live) {
        await reply(`I'm afraid I couldn't reach Jira to check **${key}** just now; please try again later.`);
        return null;
      }
      const refreshed = await refreshStatusCategory(
        this.requests, this.auditLog, request, live.statusCategory, botActor(input.conversationId), this.logger,
      );
      if (live.statusCategory === "done") {
        await reply(`**${key}** is already resolved.`);
        return null;
      }
      current = refreshed ?? { ...request, statusCategory: live.statusCategory };
    }

    const entry: Omit<AuditLogEntry, "details"> = {
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: key,
    };
    let snapshot: IssueSnapshot;
    try {
      snapshot = await this.tracker.resolveIssue(key);
    } catch (err) {
      this.logger?.warn("ResolveSupportRequest: resolveIssue failed", { key, ...trackerErrorFields(err) });
      await appendAuditSafely(this.auditLog, { ...entry, details: { outcome: "resolve_failed" } }, "ResolveSupportRequest", this.logger);
      await reply(`I'm afraid I couldn't resolve **${key}** with the service desk; please check the ticket.`);
      return null;
    }

    // The refresh audits a changed category with the actor; an unchanged one is audited here,
    // so every resolve attempt that reached the tracker has an entry.
    const refreshed = await refreshStatusCategory(
      this.requests, this.auditLog, current, snapshot.statusCategory, input.actorId, this.logger,
    );
    if (!refreshed) {
      await appendAuditSafely(this.auditLog, { ...entry, details: { statusCategory: snapshot.statusCategory } }, "ResolveSupportRequest", this.logger);
    }
    await reply(formatResolution(snapshot));
    return snapshot;
  }
}
