import type { PartDetails, SupportRequestKind } from "../../domain/entities/SupportRequest";
import type { QualifiedId } from "../../domain/ids/QualifiedId";

/**
 * Port for offers made by the answer path and confirmed by the requester. The model only
 * proposes a command; code validates it, stores it here, and runs it after confirmation.
 */

export type OfferCommand =
  /**
   * Raise a new support request: `summary` becomes the ticket title, `description` its body,
   * `requestKind` picks the request type. A part order carries its essentials in `part`; while
   * any is missing (see `missingPartDetails`) the offer can be amended but not confirmed.
   */
  | { kind: "support"; requestKind: SupportRequestKind; summary: string; description: string; part?: PartDetails }
  | { kind: "reply"; issueKey: string; body: string }
  | { kind: "resolve"; issueKey: string };

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
  /**
   * Removes the requester's pending offer without running it and remembers it as recently
   * dropped. Returns the dropped command, or null when there was no live offer.
   */
  drop(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): OfferCommand | null;
  /**
   * The requester's offer dropped or expired within `RECENT_DROP_MS`, without removing it.
   * `put` for that requester and `clearConversation` forget it.
   */
  recentlyDropped(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): OfferCommand | null;
  /** Forgets the requester's recently dropped offer, e.g. once they have moved on or were told. */
  forgetDropped(conversationId: QualifiedId, requesterId: QualifiedId): void;
}
