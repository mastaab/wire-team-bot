/**
 * Contract tests for WireOutboundAdapter.
 *
 * Verifies that each WireOutboundPort operation produces the expected SDK calls
 * using a fake SDK handler/manager.
 */
import { describe, it, expect, vi } from "vitest";
import { TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireReplyContext } from "../../src/infrastructure/wire/WireReplyContext";
import { createWireOutboundAdapter } from "../../src/infrastructure/wire/WireOutboundAdapter";
import type { HandlerManagerRef } from "../../src/infrastructure/wire/WireOutboundAdapter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };

function makeRef(
  sendMessage: (m: unknown) => Promise<string> = vi.fn().mockResolvedValue("msg-id"),
  sendAsset: (conversationId: unknown, asset: unknown) => Promise<string> = vi.fn().mockResolvedValue("asset-id"),
): HandlerManagerRef {
  return { current: { manager: { sendMessage, sendAsset, getUsers: vi.fn().mockResolvedValue([]) } } };
}

describe("WireOutboundAdapter contract", () => {
  it("sendPlainText calls manager.sendMessage with a TextMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendPlainText(convId, "Hello world");
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as { text?: string };
    expect(arg.text ?? (arg as { text: string }).text).toBe("Hello world");
  });

  it("sendPlainText returns the sent message's ID and the hash a later quote needs", async () => {
    const sendMessage = vi.fn().mockResolvedValue("sent-1");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    const ref = await adapter.sendPlainText(convId, "Raised **DS-16**.");
    const sent = sendMessage.mock.calls[0]![0] as TextMessage;
    const expected = TextMessage.createReply({ originalMessage: { ...sent, id: "sent-1" }, text: "" }).quotedMessageSha256!;
    expect(ref).toEqual({ messageId: "sent-1", sha256: Buffer.from(expected).toString("hex") });
    expect(ref!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sendPlainText quotes a stored reference, and the handler's quote wins when both are given", async () => {
    const sendMessage = vi.fn().mockResolvedValue("sent-2");
    const stored = { messageId: "bot-msg-1", sha256: "ab".repeat(32) };
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendPlainText(convId, "Update", { quote: stored });
    const quoted = sendMessage.mock.calls[0]![0] as TextMessage;
    expect(quoted.quotedMessageId).toBe("bot-msg-1");
    expect(Buffer.from(quoted.quotedMessageSha256!).toString("hex")).toBe(stored.sha256);

    const context = new WireReplyContext();
    const source = TextMessage.create({ conversationId: convId, text: "status of DS-16" });
    const withContext = createWireOutboundAdapter(makeRef(sendMessage), mockLogger, context);
    await context.withMessage(source, () => withContext.sendPlainText(convId, "Status", { replyToMessageId: source.id, quote: stored }));
    expect((sendMessage.mock.calls[1]![0] as TextMessage).quotedMessageId).toBe(source.id);
  });

  it("uses the bot's Wire display name in texts, looked up once for several minutes", async () => {
    const sendMessage = vi.fn().mockResolvedValue("sent-3");
    const getUsers = vi.fn().mockResolvedValue([{ id: { id: "bot", domain: "wire.com" }, name: "STCO-Support-Demo" }]);
    let clock = 0;
    const adapter = createWireOutboundAdapter(
      { current: { manager: { sendMessage, sendAsset: vi.fn(), getUsers } } }, mockLogger, undefined, { id: "bot", domain: "wire.com" }, () => clock,
    );
    const ref = await adapter.sendPlainText(convId, "Send `@Wire Team Bot status of DS-6`.");
    await adapter.sendCompositePrompt(convId, "Ask @Wire Team Bot", []);
    const sent = sendMessage.mock.calls[0]![0] as TextMessage;
    expect(sent.text).toBe("Send `@STCO-Support-Demo status of DS-6`.");
    expect((sendMessage.mock.calls[1]![0] as { items: Array<{ text?: string }> }).items[0]!.text).toBe("Ask @STCO-Support-Demo");
    expect(getUsers).toHaveBeenCalledTimes(1);
    expect(getUsers).toHaveBeenCalledWith([{ id: "bot", domain: "wire.com" }]);
    // The quote hash covers the text as sent.
    const expected = TextMessage.createReply({ originalMessage: { ...sent, id: "sent-3" }, text: "" }).quotedMessageSha256!;
    expect(ref!.sha256).toBe(Buffer.from(expected).toString("hex"));
    // A rename is picked up after the cache expires.
    getUsers.mockResolvedValue([{ id: { id: "bot", domain: "wire.com" }, name: "Truck Desk" }]);
    clock = 5 * 60 * 1000;
    await adapter.sendPlainText(convId, "@Wire Team Bot pause");
    expect((sendMessage.mock.calls[2]![0] as TextMessage).text).toBe("@Truck Desk pause");
  });

  it("keeps the built-in name when the display name cannot be read", async () => {
    const sendMessage = vi.fn().mockResolvedValue("sent-4");
    const getUsers = vi.fn().mockRejectedValue(new Error("offline"));
    const adapter = createWireOutboundAdapter(
      { current: { manager: { sendMessage, sendAsset: vi.fn(), getUsers } } }, mockLogger, undefined, { id: "bot", domain: "wire.com" },
    );
    await adapter.sendPlainText(convId, "@Wire Team Bot pause");
    expect((sendMessage.mock.calls[0]![0] as TextMessage).text).toBe("@Wire Team Bot pause");
  });

  it("setTyping sends started and stopped for the conversation, and does nothing without SDK support", async () => {
    const sendTypingIndicator = vi.fn().mockResolvedValue(undefined);
    const withTyping = createWireOutboundAdapter(
      { current: { manager: { sendMessage: vi.fn(), sendAsset: vi.fn(), getUsers: vi.fn(), sendTypingIndicator } } }, mockLogger,
    );
    await withTyping.setTyping(convId, true);
    await withTyping.setTyping(convId, false);
    expect(sendTypingIndicator.mock.calls.map(([c, s]) => [c.id, c.domain, s])).toEqual([["conv-1", "wire.com", "started"], ["conv-1", "wire.com", "stopped"]]);
    await expect(createWireOutboundAdapter(makeRef(), mockLogger).setTyping(convId, true)).resolves.toBeUndefined();
  });

  it("sendPlainText returns undefined without a connection", async () => {
    const adapter = createWireOutboundAdapter({ current: null }, mockLogger);
    expect(await adapter.sendPlainText(convId, "Hello")).toBeUndefined();
  });

  it("sendCompositePrompt sends a CompositeMessage with a leading text item and button items", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendCompositePrompt(convId, "Any actions?", [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]);
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as {
      type?: string;
      conversationId?: QualifiedId;
      items?: Array<{ type?: string; text?: string; id?: string }>;
    };
    expect(arg.type).toBe("composite");
    expect(arg.conversationId).toEqual(convId);
    expect(arg.items).toHaveLength(3);
    expect(arg.items?.[0]).toMatchObject({ type: "text", text: "Any actions?" });
    expect(arg.items?.[1]).toMatchObject({ type: "composite_button", id: "yes", text: "Yes" });
    expect(arg.items?.[2]).toMatchObject({ type: "composite_button", id: "no", text: "No" });
  });

  it.each(["📝", "✅", ["📝", "✅"]])("sendReaction maps %j to the qualified source message", async emoji => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendReaction(convId, "msg-1", emoji);
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as { type?: string; messageId?: string; emojiSet?: Set<string> };
    expect(arg.type).toBe("reaction");
    expect(arg.messageId).toBe("msg-1");
    expect(arg.emojiSet).toBeInstanceOf(Set);
    expect([...(arg.emojiSet ?? [])]).toEqual(typeof emoji === "string" ? [emoji] : emoji);
    expect(arg).toMatchObject({ conversationId: convId });
  });

  it("getUserProfile resolves via manager.getUsers and maps the first result", async () => {
    const getUsers = vi.fn().mockResolvedValue([
      { id: { id: "user-1", domain: "wire.com" }, name: "Ada", handle: "ada" },
    ]);
    const ref: HandlerManagerRef = { current: { manager: { sendMessage: vi.fn(), sendAsset: vi.fn(), getUsers } } };
    const adapter = createWireOutboundAdapter(ref, mockLogger);
    const profile = await adapter.getUserProfile({ id: "user-1", domain: "wire.com" });
    expect(getUsers).toHaveBeenCalledWith([{ id: "user-1", domain: "wire.com" }]);
    expect(profile).toEqual({ id: { id: "user-1", domain: "wire.com" }, name: "Ada", handle: "ada" });
  });

  it("getUserProfile returns null when getUsers yields nothing", async () => {
    const getUsers = vi.fn().mockResolvedValue([]);
    const ref: HandlerManagerRef = { current: { manager: { sendMessage: vi.fn(), sendAsset: vi.fn(), getUsers } } };
    const adapter = createWireOutboundAdapter(ref, mockLogger);
    await expect(adapter.getUserProfile({ id: "ghost", domain: "wire.com" })).resolves.toBeNull();
  });

  it("sendFile calls manager.sendAsset with Uint8Array data", async () => {
    const sendAsset = vi.fn().mockResolvedValue("asset-id");
    const adapter = createWireOutboundAdapter(makeRef(undefined, sendAsset), mockLogger);
    const { Readable } = await import("stream");
    const stream = Readable.from([Buffer.from("hello")]);
    await adapter.sendFile(convId, stream, "report.pdf", "application/pdf");
    expect(sendAsset).toHaveBeenCalledOnce();
    const [calledConvId, asset] = sendAsset.mock.calls[0]! as [unknown, { data: Uint8Array; name: string; mimeType: string }];
    expect(calledConvId).toEqual(convId);
    expect(asset.name).toBe("report.pdf");
    expect(asset.mimeType).toBe("application/pdf");
    expect(asset.data).toBeInstanceOf(Uint8Array);
  });

  it("sendPlainText is a no-op when the manager is not yet set", async () => {
    const ref: HandlerManagerRef = { current: null };
    const adapter = createWireOutboundAdapter(ref, mockLogger);
    // Should resolve without throwing
    await expect(adapter.sendPlainText(convId, "hi")).resolves.toBeUndefined();
  });
});


describe("native Wire replies", () => {
  const source = TextMessage.create({
    conversationId: convId, messageId: "incoming-1", text: "@Alice 📝 my actions",
    timestamp: new Date("2026-09-18T09:00:00.123Z"),
    mentions: [{ userId: { id: "alice", domain: "wire.com" }, offset: 0, length: 6 }],
  });

  it("keeps the source integrity hash and outgoing mentions without copying raw source text", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const context = new WireReplyContext();
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger, context);
    const mentions = [{ userId: { id: "alice", domain: "wire.com" }, offset: 0, length: 6 }];
    await context.withMessage(source, async () => {
      await adapter.sendPlainText(convId, "@Alice has two actions", { replyToMessageId: source.id, mentions });
      expect(Object.keys(context.get(convId, source.id)!)).toEqual(["quotedMessageId", "quotedMessageSha256"]);
    });
    const sent = sendMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ type: "text", conversationId: convId, text: "@Alice has two actions", mentions, quotedMessageId: source.id });
    expect(sent.quotedMessageSha256).toEqual(TextMessage.createReply({ originalMessage: source, text: "reply" }).quotedMessageSha256);
    expect(sent.quotedMessageSha256).toHaveLength(32);
    expect(JSON.stringify(sent)).not.toContain(source.text);
    expect(context.get(convId, source.id)).toBeUndefined();
  });

  it("attaches the native quote to a composite's text item", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const context = new WireReplyContext();
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger, context);
    await context.withMessage(source, () => adapter.sendCompositePrompt(convId, "Choose", [{ id: "yes", label: "Yes" }], { replyToMessageId: source.id }));
    expect(sendMessage.mock.calls[0][0].items[0]).toMatchObject({ text: "Choose", quotedMessageId: source.id, quotedMessageSha256: expect.any(Uint8Array) });
  });

  it("does not quote a different message, conversation, domain or a scheduled notification", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const context = new WireReplyContext();
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger, context);
    await context.withMessage(source, async () => {
      await adapter.sendPlainText(convId, "other source", { replyToMessageId: "incoming-2" });
      await adapter.sendPlainText({ ...convId, id: "other" }, "other channel", { replyToMessageId: source.id });
      await adapter.sendPlainText({ ...convId, domain: "other.test" }, "other domain", { replyToMessageId: source.id });
      await adapter.sendPlainText(convId, "Reminder REM-0001: check the release");
    });
    await adapter.sendPlainText(convId, "after handler", { replyToMessageId: source.id });
    expect(sendMessage).toHaveBeenCalledTimes(5);
    for (const [sent] of sendMessage.mock.calls) expect(sent.quotedMessageId).toBeUndefined();
  });

  it.each(["self-deleting", "missing timestamp"])("sends normal text for a %s source", async variant => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const context = new WireReplyContext();
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger, context);
    const incoming = { ...source, ...(variant === "self-deleting" ? { expiresAfterMillis: 60000 } : { timestamp: new Date(NaN) }) };
    await context.withMessage(incoming, () => adapter.sendPlainText(convId, "response", { replyToMessageId: source.id }));
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ text: "response" });
    expect(sendMessage.mock.calls[0][0].quotedMessageId).toBeUndefined();
  });

  it("releases quote metadata even when a send fails", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("synthetic send failure"));
    const context = new WireReplyContext();
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger, context);
    await expect(context.withMessage(source, () => adapter.sendPlainText(convId, "response", { replyToMessageId: source.id }))).rejects.toThrow("synthetic send failure");
    expect(context.get(convId, source.id)).toBeUndefined();
  });
});
