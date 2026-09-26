import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type {
  WireOutboundPort,
  OutboundTextOptions,
  CompositePromptOptions,
  CompositeButton as PromptButton,
  SentMessageRef,
  UserProfile,
} from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";
import { TextMessage, CompositeMessage, CompositeButton, Reaction } from "@wireapp/wire-apps-js-sdk";
import type { WireMessage, WireUser } from "@wireapp/wire-apps-js-sdk";
import type { WireReplyContext } from "./WireReplyContext";

/**
 * The subset of WireApplicationManager the outbound adapter needs.
 * Kept narrow so tests can supply a fake without the SDK's native dependencies.
 */
export interface ManagerHandle {
  sendMessage(message: WireMessage): Promise<string>;
  sendAsset(conversationId: QualifiedId, asset: { data: Uint8Array; name: string; mimeType: string }): Promise<string>;
  getUsers(userIds: QualifiedId[]): Promise<Array<Pick<WireUser, "id" | "name" | "handle">>>;
}

export interface HandlerManagerRef {
  current: { manager?: ManagerHandle } | null;
}

/**
 * The reference a later reply needs: the message ID and the SDK's integrity hash of the text as
 * built. Wire clients check the hash against the send time rounded to the second; the SDK does
 * not return the backend's time, so the local build time is used.
 */
function sentRef(message: TextMessage, messageId: string): SentMessageRef | undefined {
  const digest = TextMessage.createReply({ originalMessage: { ...message, id: messageId }, text: "" }).quotedMessageSha256;
  return digest ? { messageId, sha256: Buffer.from(digest).toString("hex") } : undefined;
}

async function streamToUint8Array(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  return new Promise<Uint8Array>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", reject);
  });
}

/**
 * Implements WireOutboundPort using @wireapp/wire-apps-js-sdk.
 */
export function createWireOutboundAdapter(handlerRef: HandlerManagerRef, logger: Logger, replyContext?: WireReplyContext): WireOutboundPort {
  return {
    async getUserProfile(userId: QualifiedId): Promise<UserProfile | null> {
      const h = handlerRef.current;
      if (!h?.manager) return null;
      try {
        const [profile] = await h.manager.getUsers([userId]);
        if (!profile) return null;
        return {
          id: { id: profile.id.id, domain: profile.id.domain },
          name: profile.name,
          handle: profile.handle,
        };
      } catch {
        return null;
      }
    },

    async sendPlainText(
      conversationId: QualifiedId,
      text: string,
      options?: OutboundTextOptions,
    ): Promise<SentMessageRef | undefined> {
      const h = handlerRef.current;
      if (!h?.manager) return undefined;
      logger.debug("sendPlainText", { conversationId: conversationId.id, textLength: text.length, quote: !!options?.quote });
      const handlerQuote = replyContext?.get(conversationId, options?.replyToMessageId);
      const storedQuote = !options?.replyToMessageId && options?.quote
        ? { quotedMessageId: options.quote.messageId, quotedMessageSha256: Uint8Array.from(Buffer.from(options.quote.sha256, "hex")) }
        : undefined;
      const message: TextMessage = {
        ...TextMessage.create({ conversationId, text, mentions: options?.mentions }),
        ...(handlerQuote ?? storedQuote),
      };
      const messageId = await h.manager.sendMessage(message);
      return sentRef(message, messageId);
    },

    async sendCompositePrompt(
      conversationId: QualifiedId,
      text: string,
      buttons: PromptButton[],
      options?: CompositePromptOptions,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendCompositePrompt", { conversationId: conversationId.id, textLength: text.length, buttons: buttons.map((b) => b.id) });
      await h.manager.sendMessage(
        CompositeMessage.create({
          conversationId,
          itemList: [
            {
              ...TextMessage.create({ conversationId, text }),
              ...replyContext?.get(conversationId, options?.replyToMessageId),
            },
            ...buttons.map((b) => CompositeButton.create({ id: b.id, text: b.label })),
          ],
        }),
      );
    },

    async sendReaction(
      conversationId: QualifiedId,
      messageId: string,
      emoji: string | readonly string[],
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendReaction", { conversationId: conversationId.id, messageId, emoji });
      await h.manager.sendMessage(
        Reaction.create({ conversationId, messageId, emojiSet: new Set(typeof emoji === "string" ? [emoji] : emoji) }),
      );
    },

    async sendFile(
      conversationId: QualifiedId,
      fileStream: NodeJS.ReadableStream,
      name: string,
      mimeType: string,
      _retention?: string,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendFile", { conversationId: conversationId.id, name, mimeType });
      const data = await streamToUint8Array(fileStream);
      await h.manager.sendAsset(conversationId, { data, name, mimeType });
    },
  };
}
