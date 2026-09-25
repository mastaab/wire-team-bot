import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject, jiraKeyFromLinks, toJiraLink } from "../../../domain/ids/jiraLink";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatIssueStatus, formatReplies } from "./formatIssue";

export interface GetIssueStatusInput {
  /** Either an action ID (ACT-NNNN) or a tracker key. */
  reference: string;
  conversationId: QualifiedId;
  /** Conversation timezone for reply times; UTC when absent. */
  timezone?: string;
  replyToMessageId?: string;
}

type Reply = (text: string) => Promise<void>;

const ACTION_ID_RE = /^ACT-\d+$/;
const REPLIES_SHOWN = 3;

/** Reads a linked ticket's live status, restricted to tickets linked from this conversation. */
export class GetIssueStatus {
  constructor(
    private readonly actions: ActionRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
  ) {}

  /** The only project whose keys this lookup accepts. */
  get projectKey(): string {
    return this.tracker.projectKey;
  }

  async execute(input: GetIssueStatusInput): Promise<IssueSnapshot | null> {
    const reply: Reply = text =>
      this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });

    const reference = input.reference.trim().toUpperCase();
    const key = ACTION_ID_RE.test(reference)
      ? await this.keyFromAction(reference, input.conversationId, reply)
      : await this.keyFromIssueReference(reference, input.conversationId, reply);
    if (!key) return null;

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

  private async keyFromAction(actionId: string, conversationId: QualifiedId, reply: Reply): Promise<string | null> {
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
      await reply(`I'm afraid **${action.id}** is linked to **${key}**, which is outside the ${this.tracker.projectKey} project I can look up.`);
      return null;
    }
    return key;
  }

  /** A bare key must be in the configured project and linked from an action in this conversation. */
  private async keyFromIssueReference(key: string, conversationId: QualifiedId, reply: Reply): Promise<string | null> {
    if (!isKeyInProject(key, this.tracker.projectKey)) {
      await reply(`I'm afraid I can only look up tickets in the ${this.tracker.projectKey} project.`);
      return null;
    }
    const link = toJiraLink(key);
    const candidates = await this.actions.query({ conversationId, linkedIdsHas: link, limit: 20 });
    const linkedHere = candidates.some(a =>
      !a.deleted && sameQualifiedId(a.conversationId, conversationId) && a.linkedIds.includes(link));
    if (!linkedHere) {
      await reply(`I'm afraid **${key}** isn't linked to an action in this conversation.`);
      return null;
    }
    return key;
  }
}
