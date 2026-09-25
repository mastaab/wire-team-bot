import { describe, it, expect, vi } from "vitest";
import { ConfirmOffer, classifyConfirmation, isAcknowledgement } from "../../src/application/usecases/jira/ConfirmOffer";
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
    "yes", "yes please", "yep", "yeah", "go ahead", "do it", "please do", "confirm", "confirmed",
    "Yes", "  YES!  ", "yes.", "`yes`", "yes, thanks", "yes thank you", "yeah please", "go ahead, thanks!", "Yep!!",
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
    "", "   ", "yes but change the summary first", "no, resolve DS-7 instead", "maybe", "thanks", "please",
    "yes yes", "what is the status of DS-42?", "okay so what's next", "yesterday", "ok ok",
    "ok", "okay", "sure", "ok thanks", "ok, thanks", "sure please", "y", "OK!",
  ])("does not treat %j as a confirmation", (text) => {
    expect(classifyConfirmation(text)).toBeNull();
  });
  it.each(["ok", "OK!", "okay", "sure", "ok thanks", "ok, thanks", "thanks", "y", "cheers"])("recognises %j as an acknowledgement, not a decision", (text) => {
    expect(isAcknowledgement(text)).toBe(true);
  });

  it.each(["yes", "no", "what is due today?", "ok so what's next", "okay resolve DS-7 instead"])("does not treat %j as a bare acknowledgement", (text) => {
    expect(isAcknowledgement(text)).toBe(false);
  });
});

const SUPPORT: OfferCommand = { kind: "support", summary: "VPN drops every ten minutes", description: "My VPN drops every ten minutes." };
const REPLY: OfferCommand = { kind: "reply", issueKey: "DS-6", body: "It still drops after the reset." };
const RESOLVE: OfferCommand = { kind: "resolve", issueKey: "DS-6" };

function setup(options: { store?: PendingOfferStore; clock?: () => Date } = {}) {
  const store = options.store ?? new InMemoryPendingOfferStore();
  const handlers = {
    raiseSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
    replyToServiceDesk: { execute: vi.fn().mockResolvedValue(true) },
    resolveSupportRequest: { execute: vi.fn().mockResolvedValue(null) },
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

const input = { conversationId: convId, requesterId: alice, requesterName: "Alice", replyToMessageId: "msg-9" };

function expectNothingDispatched(handlers: ReturnType<typeof setup>["handlers"]): void {
  expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
  expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
}

describe("ConfirmOffer", () => {
  it("returns false for a non-confirmation without touching the store", async () => {
    const store = { put: vi.fn(), take: vi.fn(), has: vi.fn(), clearConversation: vi.fn() };
    const { handlers, wire, useCase } = setup({ store });

    expect(await useCase.execute({ ...input, text: "yes but change the summary first" })).toBe(false);

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

  it("raises the offered support request for the requester, with their display name", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    expect(await useCase.execute({ ...input, text: "Yes please" })).toBe(true);

    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith({
      summary: "VPN drops every ten minutes", description: "My VPN drops every ten minutes.",
      conversationId: convId, requesterId: alice, requesterName: "Alice", replyToMessageId: "msg-9",
    });
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("passes no display name through when none was resolved", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    await useCase.execute({ conversationId: convId, requesterId: alice, text: "yes" });

    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledWith(expect.objectContaining({ requesterName: undefined }));
  });

  it("sends the offered reply with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer(REPLY);

    expect(await useCase.execute({ ...input, text: "go ahead" })).toBe(true);

    expect(handlers.replyToServiceDesk.execute).toHaveBeenCalledWith({
      reference: "DS-6", body: "It still drops after the reset.", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(handlers.resolveSupportRequest.execute).not.toHaveBeenCalled();
  });

  it("resolves the offered support request with the requester as actor", async () => {
    const { handlers, useCase, offer } = setup();
    offer(RESOLVE);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledWith({
      issueKey: "DS-6", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
    expect(handlers.raiseSupportRequest.execute).not.toHaveBeenCalled();
    expect(handlers.replyToServiceDesk.execute).not.toHaveBeenCalled();
  });

  it.each([
    [SUPPORT, "I need a clear yes or no, so I haven't raised anything with the service desk yet. Shall I raise it (yes or no)?"],
    [REPLY, "I need a clear yes or no, so I haven't sent the reply to **DS-6** yet. Shall I send it (yes or no)?"],
    [RESOLVE, "I need a clear yes or no, so I haven't resolved **DS-6** yet. Shall I resolve it with the service desk (yes or no)?"],
  ])("asks again after an acknowledgement for a %j offer, keeps it, and a following yes still confirms it", async (command, question) => {
    const { handlers, wire, store, useCase, offer } = setup();
    offer(command);

    expect(await useCase.execute({ ...input, text: "ok thanks" })).toBe(true);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, question, { replyToMessageId: input.replyToMessageId });
    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(true);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    const dispatched = {
      support: handlers.raiseSupportRequest.execute,
      reply: handlers.replyToServiceDesk.execute,
      resolve: handlers.resolveSupportRequest.execute,
    }[command.kind];
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it("does not treat an acknowledgement as handled when nothing is pending", async () => {
    const { handlers, wire, useCase } = setup();
    expect(await useCase.execute({ ...input, text: "ok thanks" })).toBe(false);
    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it.each([SUPPORT, REPLY, RESOLVE])("cancels a %j offer on no and consumes it", async (command) => {
    const { handlers, wire, sent, store, useCase, offer } = setup();
    offer(command);

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
    offer(SUPPORT);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expect(handlers.raiseSupportRequest.execute).toHaveBeenCalledTimes(1);
  });

  it("ignores another member's yes and keeps the requester's offer", async () => {
    const { handlers, store, useCase, offer } = setup();
    offer(RESOLVE);

    expect(await useCase.execute({ ...input, requesterId: bob, text: "yes" })).toBe(false);
    expect(await useCase.execute({ ...input, requesterId: { id: alice.id, domain: "other.example" }, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(true);
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    expect(handlers.resolveSupportRequest.execute).toHaveBeenCalledTimes(1);
  });

  it("ignores a yes in another conversation", async () => {
    const { handlers, useCase, offer } = setup();
    offer(SUPPORT);

    expect(await useCase.execute({ ...input, conversationId: { id: "conv-2", domain: "wire.com" }, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
  });

  it("does nothing for an expired offer", async () => {
    const expiresAt = new Date(now.getTime() + 60_000);
    let clock = now;
    const { handlers, wire, useCase, offer } = setup({ clock: () => clock });
    offer(SUPPORT, alice, expiresAt);

    clock = expiresAt;
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);
    expect(await useCase.execute({ ...input, text: "no" })).toBe(false);
    expect(await useCase.execute({ ...input, text: "ok" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("does nothing after the conversation's offers are cleared", async () => {
    const { handlers, store, useCase, offer } = setup();
    offer(RESOLVE);
    store.clearConversation(convId);

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(false);

    expectNothingDispatched(handlers);
  });
});
