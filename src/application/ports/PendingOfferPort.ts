import type { QualifiedId } from "../../domain/ids/QualifiedId";

/**
 * Port for offers made by the answer path and confirmed by the requester. The model only
 * proposes a command; code validates it, stores it here, and runs it after confirmation.
 */

export type OfferCommand =
  | { kind: "raise"; actionId: string }
  | { kind: "close"; actionId: string }
  | { kind: "reply"; issueKey: string; body: string };

export interface PendingOffer {
  command: OfferCommand;
  conversationId: QualifiedId;
  /** Only this member's confirmation counts. */
  requesterId: QualifiedId;
  createdAt: Date;
  expiresAt: Date;
}

export interface PendingOfferStore {
  /** Stores the offer, replacing any pending one for the same requester in the conversation. */
  put(offer: PendingOffer): void;
  /** Removes and returns the requester's pending offer, or null if there is none or it expired. */
  take(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): PendingOffer | null;
  /** True when the requester has an unexpired offer, without removing it. */
  has(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): boolean;
  /** Drops every pending offer in the conversation, e.g. when it is paused or made secure. */
  clearConversation(conversationId: QualifiedId): void;
}
