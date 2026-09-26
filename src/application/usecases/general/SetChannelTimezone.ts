import type { QualifiedId } from "../../../domain/ids/QualifiedId";

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
