import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { InboundFile } from "../../ports/PendingOfferPort";
import type { WireAssetPort } from "../../ports/WireAssetPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

/** Contract: see PLAN.md §6 "Photos and documents to the service desk". */
export interface AttachFileToRequestInput {
  issueKey: string;
  file: InboundFile;
  conversationId: QualifiedId;
  /** The member who confirmed; recorded in the audit entry. */
  actorId: QualifiedId;
  /** Display name for the attachment comment ("Photo from Wire, sent by <name>."). */
  senderName?: string;
  replyToMessageId?: string;
}

/**
 * Runs a confirmed `attach` offer: re-checks that the request belongs to this conversation
 * (`findSupportRequestInConversation`), downloads the file from Wire, attaches it to the
 * request as a public reply (`attachmentComment`), audits the attach (MIME type and size, never
 * the name or bytes), replies "Added the photo to **KEY** in Jira." and stores that reply as
 * the request's last message. The bytes stay in memory only. A failed download or upload is
 * reported plainly; an upload that may have been accepted does not invite a retry
 * (`wasRefused`). Returns true when the file was attached.
 */
export class AttachFileToRequest {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly assets: WireAssetPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  async execute(_input: AttachFileToRequestInput): Promise<boolean> {
    throw new Error("AttachFileToRequest.execute is not implemented yet");
  }
}
