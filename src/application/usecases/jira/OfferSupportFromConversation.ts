import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { MessageCategory } from "../../ports/ClassifierPort";

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
 * Contract only; the implementation is built against PLAN.md §6 "Passive service-desk help".
 * Called by the pipeline for unaddressed ACTIVE messages when passive help is on.
 */
export interface OfferSupportFromConversationPort {
  execute(input: OfferSupportInput): Promise<void>;
}
