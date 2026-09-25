import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequest, SupportRequestStatusCategory } from "../../../domain/entities/SupportRequest";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { Logger } from "../../ports/Logger";

/** Actor recorded for writes the bot makes on its own, such as a status refresh after a read. */
export function botActor(conversationId: QualifiedId): QualifiedId {
  return { id: "wire-team-bot", domain: conversationId.domain };
}

/**
 * Stores the category just read from the tracker when it differs from the last known one,
 * and audits the change. An unchanged category writes nothing. A failed write is logged and
 * never breaks the reply: the live value always comes from the tracker.
 */
export async function refreshStatusCategory(
  requests: SupportRequestRepository,
  auditLog: AuditLogRepository,
  request: SupportRequest,
  statusCategory: SupportRequestStatusCategory,
  actorId: QualifiedId,
  logger?: Logger,
): Promise<void> {
  if (request.statusCategory === statusCategory) return;
  try {
    await requests.updateStatusCategory(request.key, statusCategory, new Date());
    await auditLog.append({
      timestamp: new Date(),
      actorId,
      conversationId: request.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: request.key,
      details: { statusCategory },
    });
  } catch (err) {
    logger?.warn("Support request status refresh failed", { key: request.key, err: err instanceof Error ? err.name : "UnknownError" });
  }
}

/** The reply for a key that is not a support request of this conversation, whatever the reason. */
export function notInConversation(reference: string): string {
  return `I'm afraid **${reference.trim().toUpperCase()}** isn't a support request in this conversation.`;
}
