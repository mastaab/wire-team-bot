import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogEntry, AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatResolution } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { notInConversation } from "./supportRequestStatus";

export interface ResolveSupportRequestInput {
  issueKey: string;
  conversationId: QualifiedId;
  /** Any member of the channel may resolve; the audit entry records who did. */
  actorId: QualifiedId;
  replyToMessageId?: string;
}

/**
 * Moves a support request of this conversation to done with the service desk, stores the
 * resulting category and reports the SLA outcome. Every attempt that reaches the tracker is
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
    if (request.statusCategory === "done") {
      await reply(`**${key}** is already resolved.`);
      return null;
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
      await this.appendAudit({ ...entry, details: { outcome: "resolve_failed" } });
      await reply(`I'm afraid I couldn't resolve **${key}** with the service desk; please check the ticket.`);
      return null;
    }

    if (snapshot.statusCategory !== request.statusCategory) {
      try {
        await this.requests.updateStatusCategory(key, snapshot.statusCategory, new Date());
      } catch (err) {
        this.logger?.warn("ResolveSupportRequest: storing the status failed", { key, err: err instanceof Error ? err.name : "UnknownError" });
      }
    }
    await this.appendAudit({ ...entry, details: { statusCategory: snapshot.statusCategory } });
    await reply(formatResolution(snapshot));
    return snapshot;
  }

  /** The tracker has changed by now, so an audit failure must not suggest otherwise. */
  private async appendAudit(entry: AuditLogEntry): Promise<void> {
    try {
      await this.auditLog.append(entry);
    } catch (err) {
      this.logger?.error("ResolveSupportRequest: audit append failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
  }
}
