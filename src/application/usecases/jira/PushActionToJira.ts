import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { jiraKeyFromLinks, toJiraLink } from "../../../domain/ids/jiraLink";
import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { IssueTrackerError } from "../../ports/IssueTrackerPort";
import type { CreateIssueRequest, CreatedIssue, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

export interface PushActionToJiraInput {
  actionId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  actorName: string;
  timezone: string;
  replyToMessageId?: string;
}

export interface PushedIssue {
  key: string;
  url: string;
}

const SUMMARY_MAX = 255;
const LABEL = "wire-team-bot";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raises an open action as a tracker ticket, sending only the action's own fields. */
export class PushActionToJira {
  constructor(
    private readonly actions: ActionRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  async execute(input: PushActionToJiraInput): Promise<PushedIssue | null> {
    const reply = (text: string): Promise<void> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const action = await this.actions.findById(input.actionId);
    if (!action || action.deleted || !sameQualifiedId(action.conversationId, input.conversationId)) {
      await reply(`I'm afraid I can't find **${input.actionId}** in this conversation.`);
      return null;
    }

    if (action.status === "done" || action.status === "cancelled") {
      await reply(`I'm afraid **${action.id}** is already ${action.status}; only open actions can be raised in Jira.`);
      return null;
    }

    const existingKey = jiraKeyFromLinks(action.linkedIds);
    if (existingKey) {
      const url = await this.lookupUrl(existingKey);
      await reply(`**${action.id}** is already linked to **${existingKey}**${url ? `: ${url}` : "."}`);
      return null;
    }

    const request = buildRequest(action, input.actorName, input.timezone);
    let created: CreatedIssue;
    try {
      created = await this.tracker.createIssue(request);
    } catch (err) {
      this.logger?.warn("PushActionToJira: createIssue failed", trackerErrorFields(err));
      await reply(`I'm afraid I couldn't create a Jira ticket just now. **${action.id}** is unchanged.`);
      return null;
    }
    const { key, url } = created;

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "JiraIssue",
      entityId: key,
      details: { actionId: action.id },
    });

    const updated: Action = {
      ...action,
      linkedIds: [...action.linkedIds, toJiraLink(key)],
      version: action.version + 1,
      updatedAt: new Date(),
    };
    try {
      await this.actions.update(updated);
    } catch (err) {
      this.logger?.warn("PushActionToJira: failed to link ticket to action", trackerErrorFields(err));
      await reply(`Created **${key}** in Jira (${url}), but I'm afraid I couldn't link it to **${action.id}**.`);
      return { key, url };
    }

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Action",
      entityId: action.id,
      details: { linkedJiraKey: key },
    });

    let text = `Created **${key}** in Jira and linked it to **${action.id}**: ${url}`;
    if (!created.fieldsApplied) {
      text += `\nI'm afraid I couldn't set the ${request.dueDate ? "due date and label" : "label"} on the ticket.`;
    }
    await reply(text);
    return { key, url };
  }

  private async lookupUrl(key: string): Promise<string | null> {
    try {
      return (await this.tracker.getIssue(key))?.url ?? null;
    } catch (err) {
      this.logger?.warn("PushActionToJira: getIssue failed for linked ticket", trackerErrorFields(err));
      return null;
    }
  }
}

/** Builds the ticket from the action's own fields only (extract-and-forget). */
function buildRequest(action: Action, actorName: string, timezone: string): CreateIssueRequest {
  const description = action.description.trim();
  const dueDate = action.deadline ? calendarDate(action.deadline, timezone) : undefined;
  const lines = [description, "", `Owner: ${ownerName(action.assigneeName)}`];
  if (dueDate) lines.push(`Due: ${dueDate}`);
  lines.push(`Raised from Wire by ${actorName} (${action.id}).`);
  return {
    summary: truncate(description, SUMMARY_MAX),
    description: lines.join("\n"),
    ...(dueDate ? { dueDate } : {}),
    labels: [LABEL],
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

/** assigneeName can hold a raw user UUID when no display name was resolved. */
function ownerName(assigneeName: string): string {
  const name = assigneeName.trim();
  return name && !UUID_RE.test(name) ? name : "unassigned";
}

/** YYYY-MM-DD in the given timezone, falling back to UTC when the timezone is invalid. */
export function calendarDate(date: Date, timeZone: string): string {
  const format = (tz: string): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

/** Log fields for a failure: error name and tracker status only, never messages or bodies. */
export function trackerErrorFields(err: unknown): Record<string, unknown> {
  return {
    err: err instanceof Error ? err.name : "UnknownError",
    ...(err instanceof IssueTrackerError && err.status !== undefined ? { status: err.status } : {}),
  };
}
