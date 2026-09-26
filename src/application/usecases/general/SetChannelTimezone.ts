import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { ChannelConfig, ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import { canonicalTimeZone } from "../../../domain/services/timeZone";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import { formatTimeInZone } from "../../services/formatTimeInZone";

/** Contract: the implementation follows PLAN.md §6 "Resolve with a closing comment, and the channel timezone". */
export interface SetChannelTimezoneInput {
  conversationId: QualifiedId;
  /** Canonical channel ID used by `ChannelConfigRepository`. */
  channelId: string;
  actorId: QualifiedId;
  /** The requested IANA name; absent to show the current timezone. */
  timezone?: string;
  replyToMessageId?: string;
}

const SAVE_FAILED = "I'm afraid I couldn't save the timezone just now. Please try again.";

/**
 * Shows or sets the channel's timezone, which decides how deadlines and reminder times are read
 * and how times are shown. Stored instants do not move when the zone changes.
 */
export class SetChannelTimezone {
  constructor(
    private readonly channelConfig: ChannelConfigRepository,
    private readonly auditLog: AuditLogRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly defaultTimezone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SetChannelTimezoneInput): Promise<void> {
    if (input.timezone === undefined) {
      const config = await this.channelConfig.get(input.channelId);
      const zone = config?.timezone ?? this.defaultTimezone;
      await this.reply(input, `This channel's timezone is **${zone}** (currently ${this.currentTime(zone)}).`);
      return;
    }

    const zone = canonicalTimeZone(input.timezone);
    if (!zone) {
      await this.reply(input, `I'm afraid I don't know the timezone "${input.timezone.trim()}". Please use a name such as Europe/Berlin or America/New_York.`);
      return;
    }

    let existing: ChannelConfig | null;
    try {
      existing = await this.channelConfig.get(input.channelId);
    } catch {
      await this.reply(input, SAVE_FAILED);
      return;
    }
    const from = existing?.timezone ?? this.defaultTimezone;
    if (from === zone) {
      await this.reply(input, `This channel's timezone is already **${zone}**.`);
      return;
    }
    // Same minimal config the router creates for a channel it has no record of.
    const base: ChannelConfig = existing ?? {
      channelId: input.channelId,
      organisationId: input.conversationId.domain,
      state: "active",
      secureRanges: [],
      timezone: from,
      locale: "en",
    };
    try {
      await this.channelConfig.upsert({ ...base, timezone: zone });
    } catch {
      await this.reply(input, SAVE_FAILED);
      return;
    }

    await this.auditLog.append({
      timestamp: this.now(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "config_changed",
      entityType: "ChannelConfig",
      entityId: input.channelId,
      details: { timezone: { from, to: zone } },
    });
    await this.reply(input, `This channel's timezone is now **${zone}** (currently ${this.currentTime(zone)}).`);
  }

  private currentTime(zone: string): string {
    return formatTimeInZone(this.now(), zone, "time");
  }

  private async reply(input: SetChannelTimezoneInput, text: string): Promise<void> {
    await this.wireOutbound.sendPlainText(input.conversationId, text, { replyToMessageId: input.replyToMessageId });
  }
}
