import type { QualifiedId } from "../ids/QualifiedId";

/** Language-independent status bucket, as reported by the tracker. */
export type SupportRequestStatusCategory = "todo" | "in_progress" | "done";

/** Longest summary kept on the record and sent as the ticket title. */
export const SUPPORT_SUMMARY_MAX = 120;

/** Longest problem description sent to the ticket. */
export const SUPPORT_DESCRIPTION_MAX = 4000;

/**
 * A service-desk request raised from Wire. The tracker key is the record's ID (e.g. "DS-6").
 * The full problem description goes to the tracker and is not stored here; the summary is
 * the extract kept for recall and listing (extract-and-forget).
 */
export interface SupportRequest {
  /** Tracker key of the configured project, upper-case. */
  key: string;
  conversationId: QualifiedId;
  /** The member who raised the request. */
  requesterId: QualifiedId;
  /** Display name at the time of raising; may be empty when none was resolved. */
  requesterName: string;
  /** One line: what the requester said the problem is. */
  summary: string;
  /** Last known category, refreshed whenever the bot reads the ticket. The live value comes from the tracker. */
  statusCategory: SupportRequestStatusCategory;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
  version: number;
}
