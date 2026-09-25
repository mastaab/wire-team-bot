import { describe, it, expect } from "vitest";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import type { PendingOffer, OfferCommand } from "../../src/application/services/offers";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convA: QualifiedId = { id: "conv-1", domain: "wire.com" };
const convB: QualifiedId = { id: "conv-2", domain: "wire.com" };
const alice: QualifiedId = { id: "user-1", domain: "wire.com" };
const bob: QualifiedId = { id: "user-2", domain: "wire.com" };

const created = new Date("2026-09-25T10:00:00Z");
const expires = new Date("2026-09-25T10:10:00Z");

function offer(overrides: Partial<PendingOffer> = {}, command: OfferCommand = { kind: "raise", actionId: "ACT-0001" }): PendingOffer {
  return { command, conversationId: convA, requesterId: alice, createdAt: created, expiresAt: expires, ...overrides };
}

describe("InMemoryPendingOfferStore", () => {
  it("takes an unexpired offer once", () => {
    const store = new InMemoryPendingOfferStore();
    const o = offer({ expiresAt: new Date(Date.now() + 60_000) });
    store.put(o);

    expect(store.has(convA, alice)).toBe(true);
    expect(store.take(convA, alice)).toBe(o);
    expect(store.has(convA, alice)).toBe(false);
    expect(store.take(convA, alice)).toBeNull();
  });

  it("treats expiresAt as the exclusive boundary", () => {
    const store = new InMemoryPendingOfferStore();
    const o = offer({ expiresAt: new Date(Date.now() + 60_000) });
    store.put(o);
    const justBefore = new Date(o.expiresAt.getTime() - 1);

    expect(store.has(convA, alice, justBefore)).toBe(true);
    expect(store.has(convA, alice, o.expiresAt)).toBe(false);
    expect(store.take(convA, alice, o.expiresAt)).toBeNull();
    // The expired offer was removed, so even an earlier clock no longer finds it.
    expect(store.take(convA, alice, justBefore)).toBeNull();
  });

  it("has does not remove the offer", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));

    expect(store.has(convA, alice)).toBe(true);
    expect(store.has(convA, alice)).toBe(true);
    expect(store.take(convA, alice)).not.toBeNull();
  });

  it("replaces the requester's offer in the conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const later = new Date(Date.now() + 60_000);
    store.put(offer({ expiresAt: later }));
    const replacement = offer({ expiresAt: later }, { kind: "close", actionId: "ACT-0002" });
    store.put(replacement);

    expect(store.take(convA, alice)).toBe(replacement);
    expect(store.take(convA, alice)).toBeNull();
  });

  it("keeps offers per requester and per conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const later = new Date(Date.now() + 60_000);
    const aliceA = offer({ expiresAt: later });
    const bobA = offer({ requesterId: bob, expiresAt: later });
    const aliceB = offer({ conversationId: convB, expiresAt: later });
    store.put(aliceA);
    store.put(bobA);
    store.put(aliceB);

    expect(store.take(convA, bob)).toBe(bobA);
    expect(store.take(convA, alice)).toBe(aliceA);
    expect(store.take(convB, alice)).toBe(aliceB);
  });

  it("treats the same user ID in another domain as a different requester", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));
    const impostor: QualifiedId = { id: alice.id, domain: "other.example" };

    expect(store.has(convA, impostor)).toBe(false);
    expect(store.take(convA, impostor)).toBeNull();
    expect(store.has(convA, alice)).toBe(true);
  });

  it("treats the same conversation ID in another domain as a different conversation", () => {
    const store = new InMemoryPendingOfferStore();
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));

    expect(store.take({ id: convA.id, domain: "other.example" }, alice)).toBeNull();
    expect(store.has(convA, alice)).toBe(true);
  });

  it("clears only the given conversation", () => {
    const store = new InMemoryPendingOfferStore();
    const later = new Date(Date.now() + 60_000);
    store.put(offer({ expiresAt: later }));
    store.put(offer({ requesterId: bob, expiresAt: later }));
    store.put(offer({ conversationId: convB, expiresAt: later }));

    store.clearConversation(convA);

    expect(store.has(convA, alice)).toBe(false);
    expect(store.has(convA, bob)).toBe(false);
    expect(store.has(convB, alice)).toBe(true);
  });

  it("purges expired offers when a new one is stored", () => {
    const store = new InMemoryPendingOfferStore();
    const stale = offer({ requesterId: bob, expiresAt: new Date(Date.now() - 1000) });
    store.put(stale);
    store.put(offer({ expiresAt: new Date(Date.now() + 60_000) }));

    // With a clock before its expiry the stale offer would be live, unless it was purged.
    expect(store.has(convA, bob, new Date(stale.expiresAt.getTime() - 60_000))).toBe(false);
  });
});
