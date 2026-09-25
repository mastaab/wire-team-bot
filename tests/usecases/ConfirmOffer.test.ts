import { describe, it, expect, vi } from "vitest";
import { ConfirmOffer, classifyConfirmation } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import type { OfferCommand, PendingOfferStore } from "../../src/application/services/offers";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const alice: QualifiedId = { id: "user-1", domain: "wire.com" };
const bob: QualifiedId = { id: "user-2", domain: "wire.com" };
const now = new Date("2026-09-25T10:00:00Z");

describe("classifyConfirmation", () => {
  it.each([
    "yes", "y", "yes please", "yep", "yeah", "sure", "ok", "okay", "go ahead", "do it", "please do", "confirm", "confirmed",
    "Yes", "  YES!  ", "yes.", "`yes`", "ok, thanks", "yes thank you", "sure please", "go ahead, thanks!", "Yep!!",
  ])("treats %j as yes", (text) => {
    expect(classifyConfirmation(text)).toBe("yes");
  });

  it.each([
    "no", "n", "nope", "no thanks", "cancel", "don't", "do not", "stop",
    "No.", "NOPE!", "`cancel`", "no, thank you", "don’t", "stop please",
  ])("treats %j as no", (text) => {
    expect(classifyConfirmation(text)).toBe("no");
  });

  it.each([
    "", "   ", "yes but change the owner first", "no, raise ACT-0002 instead", "maybe", "thanks", "please",
    "yes yes", "what is the status of DS-42?", "okay so what's next", "yesterday", "ok ok",
  ])("does not treat %j as a confirmation", (text) => {
    expect(classifyConfirmation(text)).toBeNull();
  });
});

function setup(options: { store?: PendingOfferStore; clock?: () => Date } = {}) {
  const store = options.store ?? new InMemoryPendingOfferStore();
  const handlers = {
    pushActionToJira: { execute: vi.fn().mockResolvedValue(null) },
    updateActionStatus: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
  };
  const sent: string[] = [];
  const wire = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string) => { sent.push(text); }),
    getUserProfile: vi.fn(),
    sendCompositePrompt: vi.fn(),
    sendReaction: vi.fn(),
    sendFile: vi.fn(),
  };
  const useCase = new ConfirmOffer(store, handlers as unknown as ConfirmOfferHandlers, wire, options.clock ?? (() => now));
  const offer = (command: OfferCommand, requesterId: QualifiedId = alice, expiresAt = new Date(now.getTime() + 10 * 60 * 1000)): void =>
    store.put({ command, conversationId: convId, requesterId, createdAt: now, expiresAt });
  return { store, handlers, wire, sent, useCase, offer };
}

const input = { conversationId: convId, requesterId: alice, timezone: "Europe/Berlin", replyToMessageId: "msg-9" };

function expectNothingDispatched(handlers: ReturnType<typeof setup>["handlers"]): void {
  expect(handlers.pushActionToJira.execute).not.toHaveBeenCalled();
  expect(handlers.updateActionStatus.execute).not.toHaveBeenCalled();
  expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
}

describe("ConfirmOffer", () => {
  it("returns false for a non-confirmation without touching the store", async () => {
    const store = { put: vi.fn(), take: vi.fn(), has: vi.fn(), clearConversation: vi.fn() };
    const { handlers, wire, useCase } = setup({ store });

    expect(await useCase.execute({ ...input, text: "yes but change the owner first" })).toBe(false);

    expect(store.has).not.toHaveBeenCalled();
    expect(store.take).not.toHaveBeenCalled();
    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("returns false for a plain yes with nothing pending", async () => {
    const { handlers, wire, useCase } = setup();

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("raises the action with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer({ kind: "raise", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "Yes please" })).toBe(true);

    expect(handlers.pushActionToJira.execute).toHaveBeenCalledWith({
      actionId: "ACT-0010", conversationId: convId, actorId: alice, timezone: "Europe/Berlin", replyToMessageId: "msg-9",
    });
    expect(handlers.updateActionStatus.execute).not.toHaveBeenCalled();
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  });

  it("closes the action by marking it done with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer({ kind: "close", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "ok" })).toBe(true);

    expect(handlers.updateActionStatus.execute).toHaveBeenCalledWith({
      actionId: "ACT-0010", newStatus: "done", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
    expect(handlers.pushActionToJira.execute).not.toHaveBeenCalled();
  });

  it("sends the offered reply with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer({ kind: "reply", issueKey: "DS-42", body: "Section 3 is attached." });

    expect(await useCase.execute({ ...input, text: "go ahead" })).toBe(true);

    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith({
      reference: "DS-42", body: "Section 3 is attached.", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
  });

  it("cancels on no and consumes the offer", async () => {
    const { handlers, wire, sent, store, useCase, offer } = setup();
    offer({ kind: "raise", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "no thanks" })).toBe(true);

    expect(sent).toEqual(["Understood, I won't."]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, "Understood, I won't.", { replyToMessageId: "msg-9" });
    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(false);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
    expectNothingDispatched(handlers);
  });

  it("consumes the offer once", async () => {
    const { handlers, useCase, offer } = setup();
    offer({ kind: "raise", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expect(handlers.pushActionToJira.execute).toHaveBeenCalledTimes(1);
  });

  it("ignores another member's yes and keeps the requester's offer", async () => {
    const { handlers, store, useCase, offer } = setup();
    offer({ kind: "raise", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, requesterId: bob, text: "yes" })).toBe(false);
    expect(await useCase.execute({ ...input, requesterId: { id: alice.id, domain: "other.example" }, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(true);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(handlers.pushActionToJira.execute).toHaveBeenCalledTimes(1);
  });

  it("ignores a yes in another conversation", async () => {
    const { handlers, useCase, offer } = setup();
    offer({ kind: "raise", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, conversationId: { id: "conv-2", domain: "wire.com" }, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
  });

  it("does nothing for an expired offer", async () => {
    const expiresAt = new Date(now.getTime() + 60_000);
    let clock = now;
    const { handlers, wire, useCase, offer } = setup({ clock: () => clock });
    offer({ kind: "raise", actionId: "ACT-0010" }, alice, expiresAt);

    clock = expiresAt;
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
    expect(await useCase.execute({ ...input, text: "no" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("does nothing after the conversation's offers are cleared", async () => {
    const { handlers, store, useCase, offer } = setup();
    offer({ kind: "close", actionId: "ACT-0010" });
    store.clearConversation(convId);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
  });
});
