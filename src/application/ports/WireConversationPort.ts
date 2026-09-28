import type { QualifiedId } from "../../domain/ids/QualifiedId";

export interface WireUserRef {
  id: QualifiedId;
  /** Display name, for texts. */
  name: string;
}

/**
 * Creates and hands over Wire conversations for the app (customer demo: a direct conversation
 * between a requester and a desk agent). Failures carry no message content.
 */
export interface WireConversationPort {
  /** The user with exactly this handle on the bot's own domain, or null. */
  findUserByHandle(handle: string): Promise<WireUserRef | null>;
  /** A new group in the app's team with the given members (the app is its admin). */
  createGroup(name: string, members: readonly QualifiedId[]): Promise<QualifiedId>;
  makeAdmin(conversationId: QualifiedId, userId: QualifiedId): Promise<void>;
  /** The app leaves; afterwards it receives nothing from the conversation. */
  leave(conversationId: QualifiedId): Promise<void>;
}
