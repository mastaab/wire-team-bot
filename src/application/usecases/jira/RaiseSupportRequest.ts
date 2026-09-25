import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { SUPPORT_DESCRIPTION_MAX, SUPPORT_SUMMARY_MAX } from "../../../domain/entities/SupportRequest";
import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { AuditLogEntry, AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { CreateIssueRequest, CreatedIssue, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

export interface RaiseSupportRequestInput {
  /** One line; becomes the ticket title and the stored summary. */
  summary: string;
  /** The full problem description. Sent to the ticket; never stored or logged. */
  description: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** Wire display name of the requester, when resolved. */
  requesterName?: string;
  replyToMessageId?: string;
}

const LABEL = "wire-team-bot";
/** A raw user ID, optionally qualified with its domain, is not a name the desk can use. */
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(@\S+)?$/i;

/**
 * Raises a support request with the service desk and records it for this conversation.
 * The ticket carries only what the requester asked to raise plus their display name, never
 * the surrounding conversation. One bot process serves all conversations, so an in-process
 * guard per conversation and requester is enough to stop a double submit.
 */
export class RaiseSupportRequest {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  async execute(input: RaiseSupportRequestInput): Promise<SupportRequest | null> {
    const reply = (text: string): Promise<void> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const summary = input.summary.replace(/\s+/g, " ").trim();
    const description = input.description.trim();
    if (!summary || !description) {
      await reply("I'm afraid there is nothing to raise; please describe the problem.");
      return null;
    }
    if (summary.length > SUPPORT_SUMMARY_MAX) {
      await reply(`I'm afraid that summary is too long; please keep it under ${SUPPORT_SUMMARY_MAX} characters.`);
      return null;
    }
    if (description.length > SUPPORT_DESCRIPTION_MAX) {
      await reply(`I'm afraid that description is too long; please keep it under ${SUPPORT_DESCRIPTION_MAX} characters.`);
      return null;
    }

    const guardKey = [input.conversationId.id, input.conversationId.domain, input.requesterId.id, input.requesterId.domain].join("|");
    if (this.inFlight.has(guardKey)) {
      await reply("Your support request is already being raised with the service desk.");
      return null;
    }
    this.inFlight.add(guardKey);
    try {
      // Summaries often start lower-case ("my VPN drops"); a ticket title should not.
      return await this.raise(summary.charAt(0).toUpperCase() + summary.slice(1), description, input, reply);
    } finally {
      this.inFlight.delete(guardKey);
    }
  }

  private async raise(
    summary: string, description: string, input: RaiseSupportRequestInput, reply: (text: string) => Promise<void>,
  ): Promise<SupportRequest | null> {
    const requesterName = displayName(input.requesterName);
    let created: CreatedIssue;
    try {
      created = await this.tracker.createIssue(buildRequest(summary, description, requesterName));
    } catch (err) {
      this.logger?.warn("RaiseSupportRequest: createIssue failed", trackerErrorFields(err));
      await reply("I'm afraid I couldn't raise the request with the service desk just now.");
      return null;
    }
    const key = created.key.toUpperCase();
    const now = new Date();

    let stored: SupportRequest;
    try {
      stored = await this.requests.create({
        key,
        conversationId: input.conversationId,
        requesterId: input.requesterId,
        requesterName,
        summary,
        statusCategory: "todo",
        createdAt: now,
        updatedAt: now,
        deleted: false,
        version: 1,
      });
    } catch (err) {
      this.logger?.warn("RaiseSupportRequest: storing the support request failed", { key, err: err instanceof Error ? err.name : "UnknownError" });
      // The ticket exists, so record the tracker write even though the record is missing.
      await this.appendAudit({
        timestamp: new Date(), actorId: input.requesterId, conversationId: input.conversationId,
        action: "entity_created", entityType: "JiraIssue", entityId: key, details: { outcome: "store_failed" },
      });
      await reply(`Raised **${key}** with the service desk (${created.url}), but I'm afraid I couldn't record it here, so I can't follow it from this channel.`);
      return null;
    }

    await this.appendAudit({
      timestamp: new Date(), actorId: input.requesterId, conversationId: input.conversationId,
      action: "entity_created", entityType: "SupportRequest", entityId: key, details: { statusCategory: "todo" },
    });

    let text = `Raised **${key}** with the service desk: ${created.url}`;
    if (!created.fieldsApplied) text += "\nI'm afraid I couldn't set the label on the ticket.";
    await reply(text);
    return stored;
  }

  /** The ticket and record exist by now, so an audit failure must not suggest otherwise. */
  private async appendAudit(entry: AuditLogEntry): Promise<void> {
    try {
      await this.auditLog.append(entry);
    } catch (err) {
      this.logger?.error("RaiseSupportRequest: audit append failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
  }
}

/** The name kept on the record and shown to the desk; empty when none was resolved. */
function displayName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed && !USER_ID_RE.test(trimmed) ? trimmed : "";
}

/** The ticket carries the requester's own words and their name only (extract-and-forget). */
function buildRequest(summary: string, description: string, requesterName: string): CreateIssueRequest {
  const requesterLine = requesterName ? `Requested by ${requesterName} via Wire.` : "Requested via Wire.";
  return {
    summary,
    description: `${description}\n\n${requesterLine}`,
    labels: [LABEL],
  };
}
