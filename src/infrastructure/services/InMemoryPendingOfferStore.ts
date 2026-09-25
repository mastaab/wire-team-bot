import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { PendingOffer, PendingOfferStore } from "../../application/ports/PendingOfferPort";

function key(q: QualifiedId): string {
  return `${q.id}@${q.domain}`;
}

/**
 * Pending offers in process memory, one per qualified requester per qualified conversation.
 * Offers are short-lived and a restart simply drops them, so nothing is persisted.
 */
export class InMemoryPendingOfferStore implements PendingOfferStore {
  /** Conversation key to (requester key to offer). */
  private readonly offers = new Map<string, Map<string, PendingOffer>>();

  put(offer: PendingOffer): void {
    this.purgeExpired(new Date());
    const conversationKey = key(offer.conversationId);
    const byRequester = this.offers.get(conversationKey) ?? new Map<string, PendingOffer>();
    byRequester.set(key(offer.requesterId), offer);
    this.offers.set(conversationKey, byRequester);
  }

  take(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): PendingOffer | null {
    const offer = this.get(conversationId, requesterId);
    if (!offer) return null;
    this.remove(conversationId, requesterId);
    return isLive(offer, now) ? offer : null;
  }

  has(conversationId: QualifiedId, requesterId: QualifiedId, now: Date = new Date()): boolean {
    const offer = this.get(conversationId, requesterId);
    return offer !== null && isLive(offer, now);
  }

  clearConversation(conversationId: QualifiedId): void {
    this.offers.delete(key(conversationId));
  }

  private get(conversationId: QualifiedId, requesterId: QualifiedId): PendingOffer | null {
    return this.offers.get(key(conversationId))?.get(key(requesterId)) ?? null;
  }

  private remove(conversationId: QualifiedId, requesterId: QualifiedId): void {
    const conversationKey = key(conversationId);
    const byRequester = this.offers.get(conversationKey);
    if (!byRequester) return;
    byRequester.delete(key(requesterId));
    if (byRequester.size === 0) this.offers.delete(conversationKey);
  }

  private purgeExpired(now: Date): void {
    for (const [conversationKey, byRequester] of this.offers) {
      for (const [requesterKey, offer] of byRequester) {
        if (!isLive(offer, now)) byRequester.delete(requesterKey);
      }
      if (byRequester.size === 0) this.offers.delete(conversationKey);
    }
  }
}

function isLive(offer: PendingOffer, now: Date): boolean {
  return now.getTime() < offer.expiresAt.getTime();
}
