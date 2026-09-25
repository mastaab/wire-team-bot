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
 * and audits the change. Returns the updated record, or null when nothing was written: an
 * unchanged category, a record that no longer exists, or a failed write. A failure is logged
 * and never breaks the reply, since the live value always comes from the tracker.
 */
export async function refreshStatusCategory(
  requests: SupportRequestRepository,
  auditLog: AuditLogRepository,
  request: SupportRequest,
  statusCategory: SupportRequestStatusCategory,
  actorId: QualifiedId,
  logger?: Logger,
  now: Date = new Date(),
): Promise<SupportRequest | null> {
  if (request.statusCategory === statusCategory) return null;
  try {
    const updated = await requests.updateStatusCategory(request.key, statusCategory, now);
    if (!updated) return null;
    await auditLog.append({
      timestamp: now,
      actorId,
      conversationId: request.conversationId,
      action: "entity_updated",
      entityType: "SupportRequest",
      entityId: request.key,
      details: { statusCategory },
    });
    return updated;
  } catch (err) {
    logger?.warn("Support request status refresh failed", { key: request.key, err: err instanceof Error ? err.name : "UnknownError" });
    return null;
  }
}

/** The reply for a key that is not a support request of this conversation, whatever the reason. */
export function notInConversation(reference: string): string {
  return `I'm afraid **${reference.trim().toUpperCase()}** isn't a support request in this conversation.`;
}
