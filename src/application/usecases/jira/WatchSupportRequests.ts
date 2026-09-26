import type { ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { SupportRequest, SupportRequestStatusCategory } from "../../../domain/entities/SupportRequest";
import { toChannelId } from "../../../domain/ids/channelId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueChange, IssueReply, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { formatReplies, formatSla, type RepliesHeading } from "./formatIssue";
import { botActor, refreshStatusCategory } from "./supportRequestStatus";

export interface WatchCheckResult {
  /** Requests whose update was posted. */
  announced: number;
  /** Requests left for the next check: paused or secure channel, or a failed read or send. */
  pending: number;
}

/** Resolved requests stay watched this long, to catch a reopen. */
const RESOLVED_WATCH_MS = 24 * 60 * 60 * 1000;
/** Replies read per changed request. */
const REPLIES_READ = 10;
/** New replies shown in one update. */
const REPLIES_SHOWN = 3;

const NEW_REPLIES_HEADING: RepliesHeading = {
  one: "New reply from the service desk:",
  many: "New replies from the service desk:",
};

/**
 * Announces changes the service desk made in Jira (new public replies, status category
 * changes) in each support request's conversation, as a reply to the bot's last message about
 * the request. Stateful: keeps the time of the last check and the pending keys in memory; the
 * stored markers (`statusCategory`, `lastSeenReplyAt`) prevent repeats after a restart.
 * The runner calls `check()` at the configured interval, one check at a time.
 */
export class WatchSupportRequests {
  /** Start of the last check whose tracker call succeeded; absent until then. */
  private lastCheck: Date | undefined;
  /**
   * Keys to examine again at the next check, with the tracker state last seen for them. That
   * state stays current until Jira reports the issue as changed again, which replaces it.
   */
  private readonly pending = new Map<string, IssueChange>();

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
    let watched: SupportRequest[];
    try {
      watched = (await this.requests.listWatched(new Date(this.now().getTime() - RESOLVED_WATCH_MS)))
        .filter((request) => isKeyInProject(request.key, this.tracker.projectKey));
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: listWatched failed", trackerErrorFields(err));
      return this.result(0);
    }

    const byKey = new Map(watched.map((request) => [request.key, request]));
    // Pending keys no longer watched (deleted, or resolved long ago) are dropped.
    for (const key of [...this.pending.keys()]) {
      if (!byKey.has(key)) this.pending.delete(key);
    }

    const checkTime = this.now();
    if (watched.length === 0) {
      this.lastCheck = checkTime;
      return this.result(0);
    }

    let changes: IssueChange[];
    try {
      changes = await this.tracker.listChangedSince([...byKey.keys()], this.lastCheck);
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: listChangedSince failed", trackerErrorFields(err));
      return this.result(0);
    }
    const since = this.lastCheck;
    this.lastCheck = checkTime;

    const toExamine = new Map(this.pending);
    for (const change of changes) {
      if (!byKey.has(change.key)) continue;
      if (since && change.updated.getTime() <= since.getTime()) continue;
      toExamine.set(change.key, change);
    }

    let announced = 0;
    for (const [key, change] of toExamine) {
      const request = byKey.get(key)!;
      try {
        const outcome = await this.examine(request, change);
        if (outcome === "pending") {
          this.pending.set(key, change);
          continue;
        }
        this.pending.delete(key);
        if (outcome === "announced") announced++;
      } catch (err) {
        this.logger?.warn("WatchSupportRequests: request check failed", { key, ...trackerErrorFields(err) });
        this.pending.set(key, change);
      }
    }
    return this.result(announced);
  }

  private result(announced: number): WatchCheckResult {
    return { announced, pending: this.pending.size };
  }

  /** Posts the update for one request when there is one and stores the new markers. */
  private async examine(request: SupportRequest, change: IssueChange): Promise<"announced" | "silent" | "pending"> {
    const channel = await this.channels.get(toChannelId(request.conversationId));
    if (channel?.state === "paused" || channel?.state === "secure") return "pending";
    const timeZone = channel?.timezone || "UTC";

    const replies = await this.tracker.listCustomerReplies(request.key, REPLIES_READ);
    const newest = newestReplyTime(replies);
    let newReplies: IssueReply[] = [];
    let seenUpTo: Date | undefined;
    if (!request.lastSeenReplyAt) {
      // First sight of this request: take a baseline so nothing old is announced.
      seenUpTo = newest ?? request.createdAt;
    } else {
      const lastSeen = request.lastSeenReplyAt.getTime();
      newReplies = replies
        .filter((reply) => reply.created.getTime() > lastSeen && !reply.fromThisBot)
        .slice(-REPLIES_SHOWN);
      if (newest && newest.getTime() > lastSeen) seenUpTo = newest;
    }

    const statusLines = await this.statusLines(request, change.statusCategory);
    const announce = statusLines.length > 0 || newReplies.length > 0;
    if (announce) {
      const text = [
        `**${request.key}** ${request.summary}`,
        ...statusLines,
        ...(newReplies.length > 0 ? ["", formatReplies(newReplies, timeZone, NEW_REPLIES_HEADING)] : []),
      ].join("\n");
      let ref;
      try {
        ref = await this.wireOutbound.sendPlainText(
          request.conversationId, text, request.lastMessage ? { quote: request.lastMessage } : undefined,
        );
      } catch (err) {
        this.logger?.warn("WatchSupportRequests: send failed", { key: request.key, ...trackerErrorFields(err) });
        return "pending";
      }
      if (ref) {
        try {
          await this.requests.setLastMessage(request.key, ref);
        } catch (err) {
          this.logger?.warn("WatchSupportRequests: setLastMessage failed", { key: request.key, ...trackerErrorFields(err) });
        }
      }
    }

    const now = this.now();
    await refreshStatusCategory(
      this.requests, this.auditLog, request, change.statusCategory, botActor(request.conversationId), this.logger, now,
    );
    if (seenUpTo) {
      try {
        await this.requests.advanceLastSeenReplyAt(request.key, seenUpTo);
      } catch (err) {
        this.logger?.warn("WatchSupportRequests: advanceLastSeenReplyAt failed", { key: request.key, ...trackerErrorFields(err) });
      }
    }
    return announce ? "announced" : "silent";
  }

  /** The status line for a category change, with the SLA outcome after a resolve; none otherwise. */
  private async statusLines(request: SupportRequest, next: SupportRequestStatusCategory): Promise<string[]> {
    const previous = request.statusCategory;
    if (previous === next) return [];
    if (next === "done") return ["Resolved by the service desk.", ...(await this.slaLines(request.key))];
    if (previous === "done") return ["Reopened by the service desk."];
    if (next === "in_progress") return ["Now in progress."];
    return ["Moved back to To do."];
  }

  /** SLA outcome lines; none when the read fails. */
  private async slaLines(key: string): Promise<string[]> {
    try {
      const snapshot = await this.tracker.getIssue(key);
      return snapshot ? snapshot.slas.map(formatSla) : [];
    } catch (err) {
      this.logger?.warn("WatchSupportRequests: getIssue failed", { key, ...trackerErrorFields(err) });
      return [];
    }
  }
}

function newestReplyTime(replies: readonly IssueReply[]): Date | undefined {
  let newest: Date | undefined;
  for (const reply of replies) {
    if (!newest || reply.created.getTime() > newest.getTime()) newest = reply.created;
  }
  return newest;
}
