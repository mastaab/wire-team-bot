import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import { SUPPORT_SUMMARY_MAX } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { MessageCategory } from "../../ports/ClassifierPort";
import type { OfferCommand, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { OpenRequestRef, SupportDraft, SupportTriagePort } from "../../ports/SupportTriagePort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { OFFER_DESCRIPTION_MAX, OFFER_TTL_MS, formatSupportQuestion } from "../../services/offers";
import type { GetIssueStatus } from "./GetIssueStatus";

/** Classifier confidence required before passive help acts on a message. */
export const PASSIVE_CONFIDENCE_MIN = 0.8;

export interface OfferSupportInput {
  /** The unaddressed message. Sent to the model for triage only; never stored or logged. */
  text: string;
  /** Source message, for the native reply. */
  messageId: string;
  conversationId: QualifiedId;
  senderId: QualifiedId;
  senderName?: string;
  categories: readonly MessageCategory[];
  confidence: number;
  /** Conversation timezone for reply times in a status answer. */
  timezone?: string;
  /** Cancelled when the channel is paused or made secure; checked before anything is sent. */
  signal?: AbortSignal;
}

/**
 * Passive service-desk help, see PLAN.md §6 "Passive service-desk help".
 * Called by the pipeline for unaddressed ACTIVE messages when passive help is on.
 */
export interface OfferSupportFromConversationPort {
  execute(input: OfferSupportInput): Promise<void>;
}

/** Most open requests shown to the model. */
const OPEN_REQUESTS_MAX = 20;

/**
 * Offers to raise a problem noticed in an unaddressed message, or answers a status question
 * about an open request of this conversation. The model only drafts or matches; code checks
 * the result against this conversation's records and the offer bounds, writes the question,
 * and stores the offer, so nothing reaches the tracker without the speaker's yes. Failures
 * are logged by error name and stay silent in the channel.
 */
export class OfferSupportFromConversation implements OfferSupportFromConversationPort {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly triage: SupportTriagePort,
    private readonly getIssueStatus: GetIssueStatus,
    private readonly offers: PendingOfferStore,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
  ) {}

  async execute(input: OfferSupportInput): Promise<void> {
    if (!(input.confidence >= PASSIVE_CONFIDENCE_MIN)) return;
    const wantsStatus = input.categories.includes("request_status");
    const wantsOffer = input.categories.includes("service_request");
    if (!wantsStatus && !wantsOffer) return;

    const open = await this.openRequests(input.conversationId);
    if (!open) return;

    if (wantsStatus && open.length > 0) {
      const key = await this.matchStatus(input.text, open);
      if (key) {
        await this.answerStatus(input, key);
        return;
      }
    }
    if (wantsOffer) await this.offerSupport(input, open);
  }

  /** This conversation's requests not done by last known category, in the tracker's project; null when the read failed. */
  private async openRequests(conversationId: QualifiedId): Promise<OpenRequestRef[] | null> {
    const projectKey = this.getIssueStatus.projectKey;
    try {
      const records = await this.requests.listByConversation(conversationId, { openOnly: true, limit: OPEN_REQUESTS_MAX });
      return records
        .filter((r) => !r.deleted && r.statusCategory !== "done"
          && sameQualifiedId(r.conversationId, conversationId) && isKeyInProject(r.key, projectKey))
        .slice(0, OPEN_REQUESTS_MAX)
        .map((r) => ({ key: r.key, summary: r.summary }));
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: listing open requests failed", { err: errorName(err) });
      return null;
    }
  }

  /** The open request the question asks about, or null. A key the model invents is ignored. */
  private async matchStatus(text: string, open: readonly OpenRequestRef[]): Promise<string | null> {
    let key: string | null;
    try {
      key = await this.triage.matchStatusQuestion(text, open);
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: matchStatusQuestion failed", { err: errorName(err) });
      return null;
    }
    const normalised = typeof key === "string" ? key.trim().toUpperCase() : "";
    return open.find((r) => r.key === normalised)?.key ?? null;
  }

  /** Read-only: `GetIssueStatus` re-checks scope, reads the ticket live and replies to the source message. */
  private async answerStatus(input: OfferSupportInput, key: string): Promise<void> {
    if (input.signal?.aborted) return;
    try {
      await this.getIssueStatus.execute({
        reference: key,
        conversationId: input.conversationId,
        timezone: input.timezone,
        replyToMessageId: input.messageId,
      });
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: status answer failed", { err: errorName(err) });
    }
  }

  private async offerSupport(input: OfferSupportInput, open: readonly OpenRequestRef[]): Promise<void> {
    // One live offer per speaker: a new one would silently replace what they may be about to confirm.
    if (this.offers.has(input.conversationId, input.senderId)) return;

    let draft: SupportDraft | null;
    try {
      draft = await this.triage.draftRequest(input.text, open);
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: draftRequest failed", { err: errorName(err) });
      return;
    }
    if (!draft) return;

    const duplicateOf = typeof draft.duplicateOf === "string" ? draft.duplicateOf.trim().toUpperCase() : "";
    if (duplicateOf && open.some((r) => r.key === duplicateOf)) {
      this.logger?.debug("OfferSupportFromConversation: covered by an open request", { key: duplicateOf });
      return;
    }
    const command = toSupportCommand(draft);
    if (!command) {
      this.logger?.debug("OfferSupportFromConversation: draft outside the offer bounds");
      return;
    }

    if (input.signal?.aborted || this.offers.has(input.conversationId, input.senderId)) return;
    try {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        formatSupportQuestion(command.summary, command.description),
        { replyToMessageId: input.messageId },
      );
    } catch (err) {
      this.logger?.warn("OfferSupportFromConversation: sending the offer failed", { err: errorName(err) });
      return;
    }
    // A pause or secure during the send has already cleared the conversation's offers; storing
    // this one now would let it survive into the paused channel.
    if (input.signal?.aborted) return;
    const now = new Date();
    this.offers.put({
      command,
      conversationId: input.conversationId,
      requesterId: input.senderId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    });
  }
}

/** The draft as a `support` command within the offer bounds, or null. */
function toSupportCommand(draft: SupportDraft): Extract<OfferCommand, { kind: "support" }> | null {
  const summary = typeof draft.summary === "string" ? draft.summary.replace(/\s+/g, " ").trim() : "";
  const description = typeof draft.description === "string" ? draft.description.trim() : "";
  if (!summary || summary.length > SUPPORT_SUMMARY_MAX) return null;
  if (!description || description.length > OFFER_DESCRIPTION_MAX) return null;
  return { kind: "support", summary, description };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
