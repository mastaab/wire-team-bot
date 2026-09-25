import type { SupportRequest, SupportRequestStatusCategory } from "../entities/SupportRequest";
import type { QualifiedId } from "../ids/QualifiedId";

export interface SupportRequestListOptions {
  /** Only requests whose last known category is not `done`. */
  openOnly?: boolean;
  /** Only requests raised by this member. */
  requesterId?: QualifiedId;
  /** Defaults to 50. */
  limit?: number;
}

/**
 * Persistence for support requests. Callers enforce conversation scope and audit writes;
 * the repository never returns deleted records from `listByConversation`.
 */
export interface SupportRequestRepository {
  create(request: SupportRequest): Promise<SupportRequest>;
  /** Exact key lookup (upper-cased by the caller), including deleted records. */
  findByKey(key: string): Promise<SupportRequest | null>;
  /** Not-deleted requests of the conversation (qualified ID match), newest first. */
  listByConversation(conversationId: QualifiedId, options?: SupportRequestListOptions): Promise<SupportRequest[]>;
  /** Stores a new last known category, bumps `version` and `updatedAt`; returns the updated record or null when absent. */
  updateStatusCategory(key: string, statusCategory: SupportRequestStatusCategory, updatedAt: Date): Promise<SupportRequest | null>;
}
