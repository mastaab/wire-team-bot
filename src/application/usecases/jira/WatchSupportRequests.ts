import type { ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

export interface WatchCheckResult {
  /** Requests whose update was posted. */
  announced: number;
  /** Requests left for the next check: paused or secure channel, or a failed read or send. */
  pending: number;
}

/**
 * Announces changes the service desk made in Jira (new public replies, status category
 * changes) in each support request's conversation, as a reply to the bot's last message about
 * the request. Stateful: keeps the time of the last check and the pending keys in memory; the
 * stored markers (`statusCategory`, `lastSeenReplyAt`) prevent repeats after a restart.
 * The runner calls `check()` at the configured interval, one check at a time.
 */
export class WatchSupportRequests {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly tracker: IssueTrackerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly channels: ChannelConfigRepository,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<WatchCheckResult> {
    throw new Error("WatchSupportRequests.check is not implemented yet");
  }
}
