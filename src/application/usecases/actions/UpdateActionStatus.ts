import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject, jiraKeyFromLinks } from "../../../domain/ids/jiraLink";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { Logger } from "../../ports/Logger";
import { formatResolution } from "../jira/formatIssue";

export type ActionStatusUpdate = "open" | "in_progress" | "done" | "cancelled" | "overdue";

export interface UpdateActionStatusInput {
  actionId: string;
  newStatus: ActionStatusUpdate;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  completionNote?: string;
  replyToMessageId?: string;
}

export class UpdateActionStatus {
  constructor(
    private readonly actions: ActionRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    /** Optional; when present, marking a linked action done also resolves its ticket. */
    private readonly issueTracker?: IssueTrackerPort,
    private readonly logger?: Logger,
  ) {}

  async execute(input: UpdateActionStatusInput): Promise<Action | null> {
    const action = await this.actions.findById(input.actionId);
    if (!action || action.deleted || !sameQualifiedId(action.conversationId, input.conversationId)) return null;

    const updated: Action = {
      ...action,
      status: input.newStatus,
      updatedAt: new Date(),
      version: action.version + 1,
      completionNote: input.newStatus === "done" ? (input.completionNote ?? null) : action.completionNote,
    };

    await this.actions.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Action",
      entityId: updated.id,
      details: { newStatus: input.newStatus },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${updated.id}** marked as \`${input.newStatus}\`.`,
      { replyToMessageId: input.replyToMessageId },
    );

    // The Wire confirmation goes first: resolving the ticket and waiting for its SLA
    // clocks takes seconds, so its outcome follows as a second message. Only a real
    // change to done touches the ticket; repeating "done" does not claim a new close.
    if (input.newStatus === "done" && action.status !== "done") {
      const resolution = await this.resolveLinkedIssue(updated, input);
      if (resolution) {
        await this.wireOutbound.sendPlainText(input.conversationId, resolution, { replyToMessageId: input.replyToMessageId });
      }
    }

    return updated;
  }

  /** Resolves the linked ticket after the Wire-side change; a failure never rolls it back. */
  private async resolveLinkedIssue(action: Action, input: UpdateActionStatusInput): Promise<string | null> {
    const tracker = this.issueTracker;
    if (!tracker) return null;
    const key = jiraKeyFromLinks(action.linkedIds);
    if (!key || !isKeyInProject(key, tracker.projectKey)) return null;

    let snapshot: IssueSnapshot;
    try {
      snapshot = await tracker.resolveIssue(key);
    } catch (err) {
      this.logger?.warn("UpdateActionStatus: resolveIssue failed", { key, ...trackerErrorFields(err) });
      // Some transitions may have been applied before the failure, so record the attempt.
      await this.auditLog.append({
        timestamp: new Date(),
        actorId: input.actorId,
        conversationId: input.conversationId,
        action: "entity_updated",
        entityType: "JiraIssue",
        entityId: key,
        details: { outcome: "resolve_failed" },
      });
      return `I'm afraid I couldn't close **${key}** in Jira; please check it there.`;
    }
    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "JiraIssue",
      entityId: key,
      details: { statusCategory: snapshot.statusCategory },
    });
    return formatResolution(snapshot);
  }
}
