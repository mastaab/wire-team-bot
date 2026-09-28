/**
 * Contract tests for files posted in Wire (customer demo): which asset events reach the
 * attachment offer, and with what. Uses the SDK's message factories, no network.
 */
import { describe, it, expect, vi } from "vitest";
import { AssetMessage, TextMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const sender: QualifiedId = { id: "user-1", domain: "wire.com" };
const bot: QualifiedId = { id: "bot-1", domain: "wire.com" };
const remoteData = { otrKey: new Uint8Array([1]), sha256: new Uint8Array([2]), assetId: "asset-1", assetToken: "token", assetDomain: "wire.com" };

function asset(overrides: Partial<Parameters<typeof AssetMessage.create>[0]> = {}) {
  return AssetMessage.create({
    messageId: "file-1", conversationId: convId, senderId: sender, sizeInBytes: 2048, name: "brake.jpg",
    mimeType: "image/jpeg", remoteData, ...overrides,
  });
}

function deps(overrides: Partial<WireEventRouterDeps> = {}) {
  const offerAttachment = { execute: vi.fn().mockResolvedValue(true) };
  const channelState = { state: "active" as string };
  const all = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
    botUserId: bot,
    wireOutbound: { sendPlainText: vi.fn(), sendReaction: vi.fn(), getUserProfile: vi.fn().mockResolvedValue(null), sendCompositePrompt: vi.fn(), sendFile: vi.fn() },
    memberCache: new InMemoryMemberCache(),
    messageBuffer: { push: vi.fn(), getRecent: vi.fn().mockReturnValue([]), clear: vi.fn() },
    channelConfig: {
      get: vi.fn(async () => ({ channelId: "conv-1@wire.com", organisationId: "wire.com", state: channelState.state, secureRanges: [], timezone: "UTC", locale: "en" })),
      upsert: vi.fn(), setState: vi.fn(), setTimezone: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn(),
    },
    conversationConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    offerAttachment,
    ...overrides,
  } as unknown as WireEventRouterDeps;
  return { deps: all, offerAttachment, channelState };
}

describe("WireEventRouter contract: posted files", () => {
  it("offers an uploaded photo once, with its download reference and what it is, and notes it as context", async () => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset());
    expect(offerAttachment.execute).toHaveBeenCalledWith({
      conversationId: convId, senderId: sender, messageId: "file-1",
      file: { ref: { transport: "wire", data: remoteData }, fileKind: "photo", name: "brake.jpg", mimeType: "image/jpeg", sizeInBytes: 2048 },
    });
    expect(vi.mocked(d.messageBuffer.push)).toHaveBeenCalledWith(convId, expect.objectContaining({ messageId: "file-1", text: "(photo)" }));
  });

  it("ignores the preview without download data and a repeat of the same message", async () => {
    const { deps: d, offerAttachment } = deps();
    const router = new WireEventRouter(d);
    await router.onAssetMessageReceived(asset({ remoteData: null }));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
    await router.onAssetMessageReceived(asset());
    await router.onAssetMessageReceived(asset());
    expect(offerAttachment.execute).toHaveBeenCalledTimes(1);
  });

  it("completes a bare upload event with its preview's type, name, size and time", async () => {
    const replyContext = { withMessage: vi.fn((_m: unknown, handle: () => Promise<unknown>) => handle()), get: vi.fn() };
    const { deps: d, offerAttachment } = deps({ replyContext } as never);
    const router = new WireEventRouter(d);
    const previewTime = new Date("2026-09-28T10:00:00Z");
    await router.onAssetMessageReceived(asset({ remoteData: null, timestamp: previewTime }));
    // As the SDK maps an upload-only event: no original part, so an unknown type, no name, size 0.
    await router.onAssetMessageReceived(asset({ mimeType: "*/*", name: null, sizeInBytes: 0, timestamp: new Date("2026-09-28T10:00:05Z") }));
    expect(offerAttachment.execute).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ fileKind: "photo", name: "brake.jpg", mimeType: "image/jpeg", sizeInBytes: 2048 }),
    }));
    const quoted = replyContext.withMessage.mock.calls.at(-1)![0] as { timestamp: Date };
    expect(quoted.timestamp).toEqual(previewTime);
  });

  it("keeps a self-deleting preview's timer for the upload event", async () => {
    const { deps: d, offerAttachment } = deps();
    const router = new WireEventRouter(d);
    await router.onAssetMessageReceived(asset({ remoteData: null, expiresAfterMillis: 30_000 }));
    await router.onAssetMessageReceived(asset({ mimeType: "*/*", name: null, sizeInBytes: 0 }));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
  });

  it("does not use another sender's preview", async () => {
    const { deps: d, offerAttachment } = deps();
    const router = new WireEventRouter(d);
    await router.onAssetMessageReceived(asset({ remoteData: null, senderId: { id: "user-2", domain: "wire.com" } }));
    await router.onAssetMessageReceived(asset({ mimeType: "*/*", name: null, sizeInBytes: 0 }));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
  });

  it("offers a document as a file", async () => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset({ mimeType: "application/pdf", name: "delivery-note.pdf" }));
    expect(offerAttachment.execute).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ fileKind: "file", name: "delivery-note.pdf" }),
    }));
  });

  it.each([
    ["a self-deleting file", { expiresAfterMillis: 60_000 }],
    ["an unsupported type", { mimeType: "application/zip" }],
    ["a video", { mimeType: "video/mp4" }],
    ["a file over 10 MB", { sizeInBytes: 10 * 1024 * 1024 + 1 }],
    ["an empty file", { sizeInBytes: 0 }],
    ["the bot's own file", { senderId: bot }],
  ])("ignores %s", async (_label, overrides) => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset(overrides as never));
    expect(offerAttachment.execute).not.toHaveBeenCalled();
    expect(vi.mocked(d.messageBuffer.push)).not.toHaveBeenCalled();
  });

  it.each(["paused", "secure"])("ignores files in a %s channel", async (state) => {
    const { deps: d, offerAttachment, channelState } = deps();
    channelState.state = state;
    await new WireEventRouter(d).onAssetMessageReceived(asset());
    expect(offerAttachment.execute).not.toHaveBeenCalled();
  });

  it("does nothing without the attachment offer (passive help off)", async () => {
    const { deps: d } = deps({ offerAttachment: undefined });
    await new WireEventRouter(d).onAssetMessageReceived(asset());
    expect(vi.mocked(d.messageBuffer.push)).not.toHaveBeenCalled();
  });

  it("names a photo without a name generically", async () => {
    const { deps: d, offerAttachment } = deps();
    await new WireEventRouter(d).onAssetMessageReceived(asset({ name: null }));
    expect(offerAttachment.execute).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ name: "photo" }) }));
  });

  it("keeps the channel's message order with text messages", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const offerAttachment = { execute: vi.fn(() => new Promise<boolean>((resolve) => { release = () => { order.push("file"); resolve(true); }; })) };
    const { deps: d } = deps({ offerAttachment } as never);
    const router = new WireEventRouter(d);
    const file = router.onAssetMessageReceived(asset());
    const text = router.onTextMessageReceived(TextMessage.create({ conversationId: convId, text: "hello", senderId: sender } as never)).then(() => order.push("text"));
    await vi.waitFor(() => expect(offerAttachment.execute).toHaveBeenCalled());
    release();
    await Promise.all([file, text]);
    expect(order).toEqual(["file", "text"]);
  });
});
