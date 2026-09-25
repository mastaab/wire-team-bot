import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { jiraKeyFromLinks, toJiraLink } from "../../../domain/ids/jiraLink";
import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { CreateIssueRequest, CreatedIssue, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

export interface PushActionToJiraInput {
  actionId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  timezone: string;
  replyToMessageId?: string;
}

export interface PushedIssue {
  key: string;
  url: string;
}

const LABEL = "wire-team-bot";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Raises an open action as a tracker ticket, sending only the action's own fields.
 * One bot process serves all conversations, so an in-process guard is enough to stop
 * two concurrent requests for the same action from creating two tickets.
 */
export class PushActionToJira {
  private readonly inFlight = new Set<string>();

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

    if (this.inFlight.has(action.id)) {
      await reply(`**${action.id}** is already being raised in Jira.`);
      return null;
    }
    this.inFlight.add(action.id);
    try {
      return await this.raise(action, input, reply);
    } finally {
      this.inFlight.delete(action.id);
    }
  }

  private async raise(action: Action, input: PushActionToJiraInput, reply: (text: string) => Promise<void>): Promise<PushedIssue | null> {
    const request = buildRequest(action, input.timezone);
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

    try {
      // Re-read after the slow tracker call so changes made meanwhile (status, deadline,
      // owner) are not overwritten by the copy read before it.
      const current = (await this.actions.findById(action.id)) ?? action;
      await this.actions.update({
        ...current,
        linkedIds: [...current.linkedIds, toJiraLink(key)],
        version: current.version + 1,
        updatedAt: new Date(),
      });
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
function buildRequest(action: Action, timezone: string): CreateIssueRequest {
  const description = action.description.trim();
  const dueDate = action.deadline ? calendarDate(action.deadline, timezone) : undefined;
  const lines = [description, "", `Owner: ${ownerName(action.assigneeName)}`];
  if (dueDate) lines.push(`Due: ${dueDate}`);
  lines.push(`Raised from Wire (${action.id}).`);
  return {
    // Parsed descriptions often start lower-case ("prepare the report"); a ticket title should not.
    summary: description.charAt(0).toUpperCase() + description.slice(1),
    description: lines.join("\n"),
    ...(dueDate ? { dueDate } : {}),
    labels: [LABEL],
  };
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
