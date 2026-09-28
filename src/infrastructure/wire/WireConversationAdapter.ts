import { ConversationRole, QualifiedId as SdkQualifiedId } from "@wireapp/wire-apps-js-sdk";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { WireConversationPort, WireUserRef } from "../../application/ports/WireConversationPort";
import type { HandlerManagerRef } from "./WireOutboundAdapter";
import type { CreatedConversations } from "./CreatedConversations";

/** The manager calls this adapter needs; kept narrow so tests need no SDK. */
export interface ConversationManagerHandle {
  searchUsers(query: string, domain: string, numberOfResults?: number): Promise<Array<{ id: QualifiedId; name: string; handle?: string | null }>>;
  createGroupConversation(name: string, userIds: QualifiedId[]): Promise<QualifiedId>;
  updateConversationMemberRole(conversationId: QualifiedId, userId: QualifiedId, role: ConversationRole): Promise<void>;
  leaveConversation(conversationId: QualifiedId): Promise<void>;
}

export class WireNotConnectedError extends Error {
  constructor() {
    super("Wire is not connected");
    this.name = "WireNotConnectedError";
  }
}

const sdkId = (q: QualifiedId): SdkQualifiedId => new SdkQualifiedId(q.id, q.domain);

/**
 * Implements WireConversationPort over the SDK. Groups it creates are registered in `created`
 * until the app leaves them, so the router does not treat them as channels meanwhile.
 */
export function createWireConversationAdapter(
  handlerRef: HandlerManagerRef, domain: string, created: CreatedConversations,
): WireConversationPort {
  const manager = (): ConversationManagerHandle => {
    const m = handlerRef.current?.manager as Partial<ConversationManagerHandle> | undefined;
    if (!m?.createGroupConversation || !m.searchUsers || !m.updateConversationMemberRole || !m.leaveConversation) throw new WireNotConnectedError();
    return m as ConversationManagerHandle;
  };
  return {
    async findUserByHandle(handle: string): Promise<WireUserRef | null> {
      const wanted = handle.replace(/^@/, "").toLowerCase();
      const found = (await manager().searchUsers(wanted, domain, 10)).find((u) => u.handle?.toLowerCase() === wanted);
      return found ? { id: { id: found.id.id, domain: found.id.domain }, name: found.name } : null;
    },
    async createGroup(name: string, members: readonly QualifiedId[]): Promise<QualifiedId> {
      const id = await manager().createGroupConversation(name, members.map(sdkId));
      const conversationId = { id: id.id, domain: id.domain };
      created.add(conversationId);
      return conversationId;
    },
    async makeAdmin(conversationId: QualifiedId, userId: QualifiedId): Promise<void> {
      await manager().updateConversationMemberRole(sdkId(conversationId), sdkId(userId), ConversationRole.ADMIN);
    },
    async leave(conversationId: QualifiedId): Promise<void> {
      await manager().leaveConversation(sdkId(conversationId));
      created.remove(conversationId);
    },
  };
}
