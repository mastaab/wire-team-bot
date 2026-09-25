import { describe, it, expect, vi } from "vitest";
import { ConfirmOffer, classifyConfirmation } from "../../src/application/usecases/jira/ConfirmOffer";
import type { ConfirmOfferHandlers } from "../../src/application/usecases/jira/ConfirmOffer";
import { InMemoryPendingOfferStore } from "../../src/infrastructure/services/InMemoryPendingOfferStore";
import type { OfferCommand, PendingOfferStore } from "../../src/application/services/offers";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

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
    "", "   ", "yes but change the owner first", "no, raise ACT-0002 instead", "maybe", "thanks", "please",
    "yes yes", "what is the status of DS-42?", "okay so what's next", "yesterday", "ok ok",
    "ok", "okay", "sure", "ok thanks", "ok, thanks", "sure please", "y", "OK!",
  ])("does not treat %j as a confirmation", (text) => {
    expect(classifyConfirmation(text)).toBeNull();
  });
});

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0010",
    description: "Send the security questionnaire",
    rawMessageId: "",
    assigneeId: bob,
    assigneeName: "Bob",
    creatorId: alice,
    authorName: "Alice",
    conversationId: convId,
    deadline: null,
    status: "open",
    linkedIds: ["jira:DS-42"],
    reminderAt: [],
    completionNote: null,
    timestamp: now,
    updatedAt: now,
    tags: [],
    deleted: false,
    version: 1,
    ...overrides,
  };
}

function setup(options: { store?: PendingOfferStore; clock?: () => Date; found?: Action | null } = {}) {
  const store = options.store ?? new InMemoryPendingOfferStore();
  const handlers = {
    actions: {
      findById: vi.fn().mockResolvedValue(options.found === undefined ? makeAction() : options.found),
      query: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      nextId: vi.fn(),
    },
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

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(handlers.actions.findById).toHaveBeenCalledWith("ACT-0010");
    expect(handlers.updateActionStatus.execute).toHaveBeenCalledWith({
      actionId: "ACT-0010", newStatus: "done", conversationId: convId, actorId: alice, replyToMessageId: "msg-9",
    });
    expect(handlers.pushActionToJira.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["deleted", makeAction({ deleted: true })],
    ["in another conversation", makeAction({ conversationId: { id: "conv-2", domain: "wire.com" } })],
    ["in the same conversation ID on another domain", makeAction({ conversationId: { id: "conv-1", domain: "other.example" } })],
  ])("does not close an action that is %s and consumes the offer", async (_label, found) => {
    const { handlers, wire, sent, store, useCase, offer } = setup({ found });
    offer({ kind: "close", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(sent).toEqual(["I'm afraid I can't find **ACT-0010** in this conversation."]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(false);
  });

  it.each([
    ["already done", makeAction({ status: "done" })],
    ["cancelled", makeAction({ status: "cancelled" })],
    ["no longer linked to Jira", makeAction({ linkedIds: ["DEC-0001"] })],
  ])("does not close an action that is %s since the offer and consumes the offer", async (_label, found) => {
    const { handlers, wire, sent, store, useCase, offer } = setup({ found });
    offer({ kind: "close", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(sent).toEqual(["I'm afraid **ACT-0010** has changed since I asked, so I haven't changed anything."]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
    expectNothingDispatched(handlers);
    expect(store.has(convId, alice, now)).toBe(false);
  });

  it("does not read the action for a raise or a reply", async () => {
    const { handlers, useCase, offer } = setup();
    offer({ kind: "raise", actionId: "ACT-0010" });
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);
    offer({ kind: "reply", issueKey: "DS-42", body: "Hello" });
    expect(await useCase.execute({ ...input, text: "yes" })).toBe(true);

    expect(handlers.actions.findById).not.toHaveBeenCalled();
  });

  it("does not confirm on a casual acknowledgement and keeps the offer", async () => {
    const { handlers, wire, store, useCase, offer } = setup();
    offer({ kind: "close", actionId: "ACT-0010" });

    expect(await useCase.execute({ ...input, text: "ok thanks" })).toBe(false);

    expectNothingDispatched(handlers);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(store.has(convId, alice, now)).toBe(true);
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
