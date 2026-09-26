import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatIssueStatus, formatReplies } from "./formatIssue";
import { findSupportRequestInConversation } from "./supportRequestScope";
import { botActor, notInConversation, refreshStatusCategory } from "./supportRequestStatus";

export interface GetIssueStatusInput {
  /** A tracker key, e.g. "DS-6". */
  reference: string;
  conversationId: QualifiedId;
  /** Conversation timezone for reply times; UTC when absent. */
  timezone?: string;
  replyToMessageId?: string;
}

const REPLIES_SHOWN = 3;

/** Reads a support request's live status, restricted to support requests of this conversation. */
export class GetIssueStatus {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** The only project whose keys this lookup accepts. */
  get projectKey(): string {
    return this.tracker.projectKey;
  }

  async execute(input: GetIssueStatusInput): Promise<IssueSnapshot | null> {
    const reply = (text: string): Promise<SentMessageRef | undefined> =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const request = await findSupportRequestInConversation(
      this.requests, input.reference, input.conversationId, this.tracker.projectKey,
    );
    if (!request) {
      await reply(notInConversation(input.reference));
      return null;
    }
    const key = request.key;

    let snapshot: IssueSnapshot | null;
    try {
      snapshot = await this.tracker.getIssue(key);
    } catch (err) {
      this.logger?.warn("GetIssueStatus: getIssue failed", trackerErrorFields(err));
      await reply("I'm afraid I couldn't reach Jira just now.");
      return null;
    }
    if (!snapshot) {
      await reply(`I'm afraid I couldn't find **${key}** in Jira.`);
      return null;
    }
    await refreshStatusCategory(
      this.requests, this.auditLog, request, snapshot.statusCategory, botActor(input.conversationId), this.logger,
    );
    await reply(formatIssueStatus(snapshot, await this.repliesBlock(key, input.timezone ?? "UTC")));
    return snapshot;
  }

  /** Customer-facing replies only; a failed read keeps the status and says so. */
  private async repliesBlock(key: string, timeZone: string): Promise<string> {
    try {
      return formatReplies(await this.tracker.listCustomerReplies(key, REPLIES_SHOWN), timeZone);
    } catch (err) {
      this.logger?.warn("GetIssueStatus: listCustomerReplies failed", trackerErrorFields(err));
      return "I'm afraid I couldn't load the replies from Jira just now.";
    }
  }
}
