import { sameQualifiedId } from "../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import { randomUUID } from "node:crypto";
import type { AssetMessage, Conversation, ConversationMember, TextMessage, CompositeButtonAction, TextEditedMessage, WireMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventsHandler, ConversationRole } from "@wireapp/wire-apps-js-sdk";
import type { LogDecision } from "../../application/usecases/decisions/LogDecision";
import type { CreateActionFromExplicit } from "../../application/usecases/actions/CreateActionFromExplicit";
import type { UpdateActionStatus } from "../../application/usecases/actions/UpdateActionStatus";
import type { ListMyActions } from "../../application/usecases/actions/ListMyActions";
import type { ListTeamActions } from "../../application/usecases/actions/ListTeamActions";
import type { ReassignAction } from "../../application/usecases/actions/ReassignAction";
import type { UpdateActionDeadline } from "../../application/usecases/actions/UpdateActionDeadline";
import type { ListOverdueActions } from "../../application/usecases/actions/ListOverdueActions";
import type { SearchDecisions } from "../../application/usecases/decisions/SearchDecisions";
import type { ListDecisions } from "../../application/usecases/decisions/ListDecisions";
import type { SupersedeDecision } from "../../application/usecases/decisions/SupersedeDecision";
import type { RevokeDecision } from "../../application/usecases/decisions/RevokeDecision";
import type { CreateReminder } from "../../application/usecases/reminders/CreateReminder";
import type { ListMyReminders } from "../../application/usecases/reminders/ListMyReminders";
import type { CancelReminder } from "../../application/usecases/reminders/CancelReminder";
import type { SnoozeReminder } from "../../application/usecases/reminders/SnoozeReminder";
import type { AnswerQuestion } from "../../application/usecases/general/AnswerQuestion";
import type { StatusCommand } from "../../application/usecases/general/StatusCommand";
import type { CatchMeUpCommand } from "../../application/usecases/general/CatchMeUpCommand";
import type { RaiseSupportRequest } from "../../application/usecases/jira/RaiseSupportRequest";
import type { SetChannelTimezone } from "../../application/usecases/general/SetChannelTimezone";
import type { CompletePartOrder } from "../../application/usecases/jira/CompletePartOrder";
import type { ListSupportRequests } from "../../application/usecases/jira/ListSupportRequests";
import type { ResolveSupportRequest } from "../../application/usecases/jira/ResolveSupportRequest";
import type { GetIssueStatus } from "../../application/usecases/jira/GetIssueStatus";
import type { ConfirmOffer } from "../../application/usecases/jira/ConfirmOffer";
import type { ReplyToServiceDesk } from "../../application/usecases/jira/ReplyToServiceDesk";
import type { OfferCommand, PendingOfferStore } from "../../application/ports/PendingOfferPort";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";
import type { ConversationConfigRepository } from "../../domain/repositories/ConversationConfigRepository";
import type { ChannelConfigRepository } from "../../domain/repositories/ChannelConfigRepository";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { SchedulerPort } from "../../application/ports/SchedulerPort";
import type { Logger } from "../../application/ports/Logger";
import type { ActionStatus } from "../../domain/entities/Action";
import type { SlidingWindowBuffer } from "../buffer/SlidingWindowBuffer";
import type { InMemoryProcessingQueue } from "../queue/InMemoryProcessingQueue";
import type { ProcessingPipeline, MessageJob } from "../pipeline/ProcessingPipeline";
import { toChannelId } from "../../domain/ids/channelId";
import { bindUserMentions } from "./bindUserMentions";
import { hasMultipleCommands } from "./hasMultipleCommands";
import { parseAddressedAction } from "./parseAddressedAction";
import { matchIssueStatusRequest } from "./matchIssueStatusRequest";
import { splitSupportText } from "./splitSupportText";
import { welcomeText, type SupportWelcome } from "./welcomeText";
import type { OfferAttachment } from "../../application/usecases/jira/OfferAttachment";
import { ATTACHMENT_MAX_BYTES, attachableKind } from "../../application/services/attachments";
import type { WireReplyContext } from "./WireReplyContext";

const CONTEXT_WINDOW = 10;
const NAME_TTL_MS = 24 * 60 * 60 * 1000; // re-fetch display names after 24 h to catch renames

/**
 * The SDK serialises and accepts this message type but does not export its factory
 * from the package entrypoint, so we build it from the exported union instead.
 */
type ButtonActionConfirmation = Extract<WireMessage, { type: "composite_button_action_confirmation" }>;

/** True for a support offer that orders a replacement part, complete or not. */
function isPartOrder(command: OfferCommand): boolean {
  return command.kind === "support" && command.requestKind === "part";
}

function toCachedRole(role: ConversationRole): CachedMember["role"] {
  return role === ConversationRole.ADMIN ? "admin" : "member";
}

export interface WireEventRouterDeps {
  logger: Logger;
  // Decisions
  logDecision: LogDecision;
  searchDecisions: SearchDecisions;
  listDecisions: ListDecisions;
  supersedeDecision: SupersedeDecision;
  revokeDecision: RevokeDecision;
  // Actions
  createActionFromExplicit: CreateActionFromExplicit;
  updateActionStatus: UpdateActionStatus;
  reassignAction: ReassignAction;
  updateActionDeadline: UpdateActionDeadline;
  listMyActions: ListMyActions;
  listTeamActions: ListTeamActions;
  listOverdueActions: ListOverdueActions;
  // Reminders
  createReminder: CreateReminder;
  listMyReminders: ListMyReminders;
  cancelReminder: CancelReminder;
  snoozeReminder: SnoozeReminder;
  // General
  answerQuestion: AnswerQuestion;
  /** Phase 3: optional — reports channel state, entity counts, etc. */
  statusCommand?: StatusCommand;
  /** Phase 4: optional — handles "catch me up" / "what did I miss" queries. */
  catchMeUpCommand?: CatchMeUpCommand;
  /** Customer demo: present only when the Jira integration is configured. */
  /** Sets or shows the channel's timezone (`@bot timezone Europe/Berlin`). */
  setChannelTimezone?: SetChannelTimezone;
  /** Timezone for channels the bot newly joins; UTC when absent. */
  defaultTimezone?: string;
  raiseSupportRequest?: RaiseSupportRequest;
  /** Fills a pending part order's missing essentials from the requester's next message, in code. */
  completePartOrder?: CompletePartOrder;
  /** What the welcome says about the service desk; absent when the integration is off. */
  supportWelcome?: SupportWelcome;
  /** Offers to attach posted photos and documents to an open request; wired only with passive help on. */
  offerAttachment?: OfferAttachment;
  listSupportRequests?: ListSupportRequests;
  resolveSupportRequest?: ResolveSupportRequest;
  getIssueStatus?: GetIssueStatus;
  replyToServiceDesk?: ReplyToServiceDesk;
  /** Offers made by the answer path, confirmed with a short "yes" or "no". */
  pendingOffers?: PendingOfferStore;
  confirmOffer?: ConfirmOffer;
  // Infrastructure
  botUserId: QualifiedId;
  wireOutbound: WireOutboundPort;
  replyContext?: WireReplyContext;
  messageBuffer: ConversationMessageBuffer;
  dateTimeService: DateTimeService;
  memberCache: ConversationMemberCache;
  /** Legacy config repo — still used by existing use-cases (e.g. timezone lookup). Kept for Phase 1 compat. */
  conversationConfig: ConversationConfigRepository;
  /** v2 channel config repo — drives the state machine. */
  channelConfig: ChannelConfigRepository;
  slidingWindow: SlidingWindowBuffer;
  scheduler: SchedulerPort;
  secretModeInactivityMs: number;
  /**
   * Phase 2: background processing pipeline.
   * Optional — when not provided, the pipeline is disabled (tests / Phase 1 mode).
   */
  processingQueue?: InMemoryProcessingQueue<MessageJob>;
  pipeline?: ProcessingPipeline;
  /** Wire domain string used as org scope for pipeline extractions. Defaults to botUserId.domain. */
  orgId?: string;
}

export class WireEventRouter extends WireEventsHandler {
  private readonly channelStateCache = new Map<string, "active" | "paused" | "secure">();
  /** True when the channel is a 1:1 DM (one non-bot member). Enables personal-mode retrieval scope. */
  private readonly personalModeCache = new Map<string, boolean>();
  private readonly lastActivityByConv = new Map<string, number>();
  private readonly knownConvs = new Set<string>();


  constructor(private readonly deps: WireEventRouterDeps) {
    super();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────────────────────────────────

  private readonly handlers = new Map<string, Promise<void>>();

  async onTextMessageReceived(wireMessage: TextMessage): Promise<void> {
    const channelId = toChannelId(wireMessage.conversationId);
    const previous = this.handlers.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      const process = () => this.processTextMessage(wireMessage);
      return this.deps.replyContext ? this.deps.replyContext.withMessage(wireMessage, process) : process();
    });
    this.handlers.set(channelId, current);
    try { await current; } finally {
      if (this.handlers.get(channelId) === current) this.handlers.delete(channelId);
    }
  }

  private async processTextMessage(wireMessage: TextMessage): Promise<void> {
    const text = wireMessage.text ?? "";
    const convId = wireMessage.conversationId as QualifiedId;
    const sender = wireMessage.sender as QualifiedId;
    const channelId = toChannelId(convId);
    let senderMember = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender));

    // Name resolution strategy:
    //   a) Name missing (not yet fetched, or sender not in cache): AWAIT the profile call so
    //      that senderName is correct for the sliding window, pipeline job, and all command
    //      handlers.  A single awaited call is far cheaper than downstream UUID corruption.
    //   b) Name present but older than NAME_TTL_MS: fire-and-forget refresh — we already have
    //      a valid name to use for this message; the next message gets the refreshed value.
    const nameAge = senderMember?.nameResolvedAt
      ? Date.now() - senderMember.nameResolvedAt.getTime()
      : Infinity;
    if (!senderMember?.name) {
      try {
        const profile = await this.deps.wireOutbound.getUserProfile(sender);
        if (profile?.name) {
          if (senderMember) {
            this.deps.memberCache.updateMemberName(convId, sender, profile.name, profile.handle);
          } else {
            // Sender not in cache — may happen if the bot missed a join event.
            this.deps.memberCache.addMembers(convId, [{
              userId: sender,
              role: "member",
              name: profile.name,
              handle: profile.handle,
              nameResolvedAt: new Date(),
            }]);
          }
          // Re-read so messageBuffer and handleTextMessage see the resolved name.
          senderMember = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender));
        }
      } catch { /* non-fatal — proceed without name */ }
    } else if (nameAge > NAME_TTL_MS) {
      // Stale but present: background refresh only.
      void this.deps.wireOutbound.getUserProfile(sender).then((profile) => {
        if (profile?.name) this.deps.memberCache.updateMemberName(convId, sender, profile.name, profile.handle);
      });
    }

    // Child logger is created after name resolution so senderName is always available.
    const log = this.deps.logger.child({
      conversationId: convId.id,
      senderId: sender.id,
      senderName: senderMember?.name || undefined,
      messageId: wireMessage.id,
    });

    this.lastActivityByConv.set(channelId, Date.now());

    if (!this.knownConvs.has(channelId)) {
      this.knownConvs.add(channelId);
      await this.hydrateChannelState(convId, channelId, log);
    }

    try {
      await this.handleTextMessage(wireMessage, text, convId, sender, channelId, log);
    } catch (err) {
      log.error("Handler failed", { err: (err instanceof Error ? err.name : "UnknownError"), errorType: err instanceof Error ? err.name : undefined });
      try {
        await this.deps.wireOutbound.sendPlainText(convId, "Something went wrong. Please try again.", {
          replyToMessageId: wireMessage.id,
        });
      } catch (sendErr) {
        log.error("Failed to send error reply", { err: (sendErr instanceof Error ? sendErr.name : "UnknownError") });
      }
    }
  }

  private async hydrateChannelState(convId: QualifiedId, channelId: string, log: Logger): Promise<void> {
    try {
      const cfg = await this.deps.channelConfig.get(channelId);
      if (cfg) {
        this.channelStateCache.set(channelId, cfg.state as "active" | "paused" | "secure");
        this.personalModeCache.set(channelId, cfg.isPersonalMode ?? false);
        if (cfg.state === "secure") this.scheduleInactivityCheck(convId, channelId);
        log.info("Channel state restored from DB", { state: cfg.state });
        return;
      }
      const legacyCfg = await this.deps.conversationConfig.get(convId);
      if (legacyCfg?.secretMode) {
        this.channelStateCache.set(channelId, "secure");
        this.scheduleInactivityCheck(convId, channelId);
        log.info("Channel state restored from legacy DB (secretMode=true)");
      } else {
        this.channelStateCache.set(channelId, "active");
      }
    } catch (err) {
      log.warn("Failed to hydrate channel state", { err: (err instanceof Error ? err.name : "UnknownError") });
      this.channelStateCache.set(channelId, "paused");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core message handler
  // ─────────────────────────────────────────────────────────────────────────

  private async handleTextMessage(
    wireMessage: TextMessage,
    text: string,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    log: Logger,
  ): Promise<void> {
    const lowered = text.trim().toLowerCase();
    const channelState = this.channelStateCache.get(channelId) ?? "active";
    const botMentionedEarly = wireMessage.mentions?.some((m) => sameQualifiedId(m.userId, this.deps.botUserId)) ?? false;
    const isBotAddressed = botMentionedEarly || this.startsWithBotName(lowered);
    const addressedText = isBotAddressed ? this.stripAddressedBotPrefix(text, wireMessage) : text.trim();
    // Pasted command examples may retain inline-code delimiters around the ID,
    // command prefix, or whole command. Do not unwrap prose, fences or multiline code.
    const commandText = addressedText.replace(/^`([^`\r\n]+)`(?=\s|$)/, "$1");
    const commandLowered = commandText.toLowerCase();
    // Bind person spans before removing prefixes/formatting: Wire offsets refer to
    // the original UTF-16 text. Labels must never be reparsed as user identities.
    const mentionBindings = bindUserMentions(text, wireMessage.mentions ?? [], this.deps.botUserId);
    const identityText = mentionBindings
      ? (isBotAddressed ? this.stripAddressedBotPrefix(mentionBindings.text, wireMessage) : mentionBindings.text.trim())
        .replace(/^`([^`\r\n]+)`(?=\s|$)/, "$1")
      : "";
    const restoreLabels = (value: string) => mentionBindings?.restore(value) ?? value;

    const cachedMembers = this.deps.memberCache.getMembers(convId);
    const senderEntry = cachedMembers.find((m) => sameQualifiedId(m.userId, sender));
    const senderDisplayName = senderEntry?.name || undefined;

    const members = cachedMembers.map((m) => ({
      id: m.userId.id,
      domain: m.userId.domain,
      name: m.name,
    }));

    // ── PAUSED ────────────────────────────────────────────────────────────────
    if (channelState === "paused") {
      const botMentioned = wireMessage.mentions?.some((m) => sameQualifiedId(m.userId, this.deps.botUserId)) ?? false;
      if (!botMentioned) {
        log.debug("Channel paused — message discarded");
        return;
      }
      if (this.matchesResumeCommand(commandLowered)) {
        await this.setChannelState(convId, channelId, "active", sender.id, wireMessage.id, log);
        return;
      }
      if (this.matchesSecureCommand(commandLowered)) {
        await this.setChannelState(convId, channelId, "secure", sender.id, wireMessage.id, log);
        return;
      }
      await this.deps.wireOutbound.sendPlainText(
        convId,
        "I'm currently standing by. Mention me with _\"resume\"_ to bring me back.",
        { replyToMessageId: wireMessage.id },
      );
      return;
    }

    // ── SECURE ────────────────────────────────────────────────────────────────
    if (channelState === "secure") {
      this.scheduleInactivityCheck(convId, channelId);
      this.deps.slidingWindow.flush(channelId);
      const botMentioned = wireMessage.mentions?.some((m) => sameQualifiedId(m.userId, this.deps.botUserId)) ?? false;
      if (botMentioned && this.matchesResumeCommand(commandLowered)) {
        await this.setChannelState(convId, channelId, "active", sender.id, wireMessage.id, log);
        return;
      }
      log.debug("Secure mode active — message discarded");
      return;
    }

    // Reject a command bundle before any write, buffering or model work.
    // A short "yes"/"no" to a pending Jira offer (customer demo). Checked before commands and
    // before the multi-command guard and the follow-up handling further down, which would otherwise
    // send the "yes" to the read-only Q&A path. Only the member who received the offer can confirm it, and only with
    // their next message: anything else drops the offer, so a later "yes" meant for a different
    // question can never confirm it. A bare "yes" shortly after a dropped or expired offer is
    // also handed over, so it gets an answer instead of silence. A dropped offer travels with
    // this message to the answer path, so a correction can produce a revised offer.
    let droppedOffer: OfferCommand | undefined;
    const pendingOffers = this.deps.pendingOffers;
    if (this.deps.confirmOffer && pendingOffers
        && (pendingOffers.has(convId, sender) || pendingOffers.recentlyDropped(convId, sender))) {
      const handled = await this.deps.confirmOffer.execute({
        text: commandText, conversationId: convId, requesterId: sender,
        requesterName: senderDisplayName, replyToMessageId: wireMessage.id,
      });
      if (handled) {
        // Record the answer so the answer model sees the offer as closed, not pending, and a bot
        // entry after it, so the offer's "(yes or no)?" no longer counts as the bot's latest
        // question: otherwise the requester's next message would be taken as a follow-up.
        const now = new Date();
        this.deps.messageBuffer.push(convId, {
          messageId: wireMessage.id, senderId: sender, senderName: senderDisplayName ?? "", text, timestamp: now,
        });
        this.deps.messageBuffer.push(convId, {
          messageId: `bot-${now.getTime()}`, senderId: this.deps.botUserId, senderName: "Wire Team Bot",
          text: "(Answered the offer above.)", timestamp: now,
        });
        return;
      }
      droppedOffer = pendingOffers.drop(convId, sender) ?? undefined;
      // With no live offer, only a recently dropped one brought us here and the requester has
      // moved on, so a later yes (perhaps to a colleague) is not answered about it.
      if (!droppedOffer) pendingOffers.forgetDropped(convId, sender);
      // A part-order draft: an answer ("two, deliver to depot north") or a correction ("actually
      // three") is merged in code, without relying on the answer model to return a revised offer.
      // A message to the bot (a command or a question) is not an answer to the draft.
      if (droppedOffer && this.deps.completePartOrder && isPartOrder(droppedOffer) && !isBotAddressed) {
        const completed = await this.deps.completePartOrder.execute({
          text: commandText, conversationId: convId, requesterId: sender, pending: droppedOffer, replyToMessageId: wireMessage.id,
        });
        if (completed) {
          const now = new Date();
          this.deps.messageBuffer.push(convId, {
            messageId: wireMessage.id, senderId: sender, senderName: senderDisplayName ?? "", text, timestamp: now,
          });
          this.deps.messageBuffer.push(convId, {
            messageId: `bot-${now.getTime()}`, senderId: this.deps.botUserId, senderName: "Wire Team Bot",
            text: "(Updated the part order draft.)", timestamp: now,
          });
          return;
        }
      }
    }

    if (hasMultipleCommands(text, wireMessage.mentions ?? [], this.deps.botUserId, this.deps.getIssueStatus?.projectKey)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "Please send one command per message. I have not run any commands from this message.",
        { replyToMessageId: wireMessage.id });
      return;
    }

    // ── ACTIVE — state-change commands ────────────────────────────────────────
    if (isBotAddressed) {
      if (this.matchesPauseCommand(commandLowered)) {
        await this.setChannelState(convId, channelId, "paused", sender.id, wireMessage.id, log);
        return;
      }
      if (this.matchesSecureCommand(commandLowered)) {
        await this.setChannelState(convId, channelId, "secure", sender.id, wireMessage.id, log);
        return;
      }
      if (this.matchesResumeCommand(commandLowered)) {
        await this.deps.wireOutbound.sendPlainText(convId, "I am already at your service.", { replyToMessageId: wireMessage.id });
        return;
      }
      const contextMatch = this.matchContextCommand(commandText);
      if (contextMatch) {
        await this.handleContextCommand(contextMatch, convId, channelId, sender, wireMessage.id, log);
        return;
      }

      // @Wire Team Bot timezone [Europe/Berlin], "set our time zone to Europe/Berlin",
      // "timezone: Europe/Berlin". An argument that does not look like a zone name ("timezone
      // differences?") is a question for the normal routing.
      const timezoneMatch = commandText.match(
        /^(?:(?:set|change)\s+(?:(?:our|the|this\s+channel['’]s|the\s+channel['’]s)\s+)?)?time\s*zone(?:[.!?]|(?:\s*:\s*|\s+(?:to\s+)?)(\S.*?))?\s*$/i,
      );
      const timezoneArg = timezoneMatch?.[1]?.replace(/[.!]$/, "");
      if (timezoneMatch && this.deps.setChannelTimezone
          && (timezoneArg === undefined || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezoneArg))) {
        await this.deps.setChannelTimezone.execute({
          conversationId: convId, channelId, actorId: sender,
          ...(timezoneArg ? { timezone: timezoneArg } : {}),
          replyToMessageId: wireMessage.id,
        });
        return;
      }

      // @Wire Team Bot status
      if (/^(?:channel\s+)?status[?.!]?$/i.test(commandLowered) && this.deps.statusCommand) {
        await this.deps.statusCommand.execute({
          conversationId: convId,
          channelId,
          replyToMessageId: wireMessage.id,
        });
        return;
      }

      // @Wire Team Bot catch me up / what did I miss
      if (
        /catch\s+me\s+up/i.test(commandLowered) ||
        /what(?:'s|\s+is|\s+was)?\s+(?:new|happening)/i.test(commandLowered) ||
        /what\s+did\s+i\s+miss/i.test(commandLowered)
      ) {
        if (this.deps.catchMeUpCommand) {
          const orgId = this.deps.orgId ?? convId.domain;
          await this.deps.catchMeUpCommand.execute({
            conversationId: convId,
            channelId,
            organisationId: orgId,
            replyToMessageId: wireMessage.id,
          });
          return;
        }
      }
    }

    this.deps.messageBuffer.push(convId, {
      messageId: wireMessage.id,
      senderId: sender,
      senderName: senderDisplayName ?? "",
      text,
      timestamp: new Date(),
    });
    this.deps.slidingWindow.push(channelId, {
      messageId: wireMessage.id,
      authorId: sender.id,
      authorName: senderDisplayName,
      text,
      timestamp: new Date(),
    });

    // ── Fast-path: ID-based mutations ─────────────────────────────────────────
    // Match prefixes without case sensitivity; persistence uses canonical uppercase IDs.

    // cancel REM-NNNN
    const cancelReminderMatch = commandText.match(/^cancel\s+(REM-\d+)\s*$/i);
    if (cancelReminderMatch) {
      await this.deps.cancelReminder.execute({
        reminderId: cancelReminderMatch[1].toUpperCase(), conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // snooze REM-NNNN <expression>
    const snoozeReminderMatch = commandText.match(/^snooze\s+(REM-\d+)\s+(.+)$/i);
    if (snoozeReminderMatch) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.snoozeReminder.execute({
        reminderId: snoozeReminderMatch[1].toUpperCase(), conversationId: convId, actorId: sender,
        snoozeExpression: snoozeReminderMatch[2].trim(),
        timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC",
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // Support requests (customer demo). Writes to the service desk need the bot to be
    // addressed, so a teammate's chat that happens to start with "support:", "resolve DS-4" or
    // "reply to DS-4:" never reaches Jira. Only keys of the configured project match.
    const jiraProjectKey = this.deps.getIssueStatus?.projectKey;
    const supportMatch = this.deps.raiseSupportRequest && isBotAddressed ? commandText.match(/^support\s*:\s*([\s\S]+)$/i) : null;
    if (supportMatch && this.deps.raiseSupportRequest) {
      const { summary, description } = splitSupportText(supportMatch[1]!);
      await this.deps.raiseSupportRequest.execute({
        summary, description, conversationId: convId, requesterId: sender,
        requesterName: senderDisplayName, replyToMessageId: wireMessage.id, requestKind: "fault",
      });
      return;
    }

    const resolveMatch = jiraProjectKey && isBotAddressed
      ? commandText.match(new RegExp(`^(?:resolve|close)\\s+(${jiraProjectKey}-\\d+)(?:\\s*:\\s*([\\s\\S]+)|[.!]?\\s*)$`, "i"))
      : null;
    if (resolveMatch && this.deps.resolveSupportRequest) {
      // `resolve DS-6: <comment>` adds a closing comment before resolving.
      const comment = resolveMatch[2]?.trim();
      await this.deps.resolveSupportRequest.execute({
        issueKey: resolveMatch[1]!.toUpperCase(), conversationId: convId, actorId: sender,
        ...(comment ? { comment } : {}), replyToMessageId: wireMessage.id,
      });
      return;
    }

    const replyMatch = jiraProjectKey && isBotAddressed
      ? commandText.match(new RegExp(`^reply\\s+to\\s+(${jiraProjectKey}-\\d+)\\s*:\\s*([\\s\\S]+)$`, "i"))
      : null;
    if (replyMatch && this.deps.replyToServiceDesk) {
      await this.deps.replyToServiceDesk.execute({
        reference: replyMatch[1]!.toUpperCase(), body: replyMatch[2]!, conversationId: convId,
        actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    const supportListMatch = this.deps.listSupportRequests && isBotAddressed
      ? commandLowered.match(/^(my\s+)?(?:open\s+)?support\s+requests?[?.]?\s*$/)
      : null;
    if (supportListMatch && this.deps.listSupportRequests) {
      await this.deps.listSupportRequests.execute({
        conversationId: convId, ...(supportListMatch[1] ? { requesterId: sender } : {}), replyToMessageId: wireMessage.id,
      });
      return;
    }

    // Jira status lookups (customer demo): the exact command, or natural phrasing when the bot
    // is addressed. Only keys of the configured project match; see matchIssueStatusRequest.
    const issueReference = jiraProjectKey && isBotAddressed ? matchIssueStatusRequest(commandText, jiraProjectKey) : null;
    if (issueReference && this.deps.getIssueStatus) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.getIssueStatus.execute({
        reference: issueReference, conversationId: convId,
        timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN reassign / assign ACT-NNNN to <name>
    const actReassignMatch = identityText.match(/^(?:(ACT-\d+)\s+reassign\s+to\s+(.+)|(?:assign|reassign)\s+(ACT-\d+)\s+to\s+(.+))$/i);
    if (actReassignMatch) {
      const actionId = (actReassignMatch[1] ?? actReassignMatch[3])!.toUpperCase();
      const newAssignee = (actReassignMatch[2] ?? actReassignMatch[4])!.trim();
      await this.deps.reassignAction.execute({
        actionId, conversationId: convId, newAssigneeReference: restoreLabels(newAssignee), newAssigneeId: mentionBindings?.owner(newAssignee)?.userId, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN status or status ACT-NNNN
    const actDoneMatch = commandText.match(/^(?:(ACT-\d+)\s+(done|cancelled|in[_\s]progress|close|complete|cancel)|(done|close|complete|cancel|cancelled|in[_\s]progress)\s+(ACT-\d+))\s*(.*)$/i);
    if (actDoneMatch) {
      const actionId = (actDoneMatch[1] ?? actDoneMatch[4])!.toUpperCase();
      const rawStatus = (actDoneMatch[2] ?? actDoneMatch[3])!.toLowerCase();
      const note = actDoneMatch[5]?.trim() || undefined;
      const normStatus = rawStatus === "close" || rawStatus === "complete" ? "done"
        : rawStatus === "cancel" ? "cancelled"
        : rawStatus.replace(/\s/, "_") as ActionStatus;
      await this.deps.updateActionStatus.execute({
        actionId, newStatus: normStatus as "done" | "cancelled" | "in_progress",
        conversationId: convId, actorId: sender,
        completionNote: note, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN due <expression>
    const actDeadlineMatch = commandText.match(/^(ACT-\d+)\s+due\s+(.+)$/i);
    if (actDeadlineMatch) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.updateActionDeadline.execute({
        actionId: actDeadlineMatch[1].toUpperCase(), conversationId: convId, actorId: sender,
        deadlineText: actDeadlineMatch[2].trim(), timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC",
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    const revokeMatch = commandText.match(/^revoke\s+(DEC-\d+)\s*(.*)$/i);
    if (revokeMatch) {
      await this.deps.revokeDecision.execute({
        conversationId: convId, actorId: sender,
        decisionId: revokeMatch[1].toUpperCase(), reason: revokeMatch[2].trim() || undefined, replyToMessageId: wireMessage.id,
      });
      return;
    }

    const supersedeMatch = commandText.match(/^decision:\s*(.+?)\s+supersedes\s+(DEC-\d+)\s*$/i);
    if (supersedeMatch) {
      await this.deps.supersedeDecision.execute({
        conversationId: convId, authorId: sender, authorName: senderDisplayName ?? "",
        rawMessageId: wireMessage.id,
        newSummary: supersedeMatch[1].trim(), supersedesDecisionId: supersedeMatch[2].toUpperCase(),
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // decision: <summary>
    const decisionMatch = commandText.match(/^decision:\s*(.+)$/i);
    if (decisionMatch) {
      const contextMessages = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
      const participantIds = contextMessages.length
        ? [...new Map(contextMessages.map((m) => [m.senderId.id, m.senderId])).values()]
        : [sender];
      await this.deps.logDecision.execute({
        conversationId: convId, authorId: sender, authorName: senderDisplayName ?? "",
        rawMessageId: wireMessage.id,
        summary: decisionMatch[1].trim(), contextMessages, participantIds,
      });
      return;
    }

    // action: <description> [for <Name>] or action: <Name> to <description>
    const actionMatch = identityText.match(/^action:\s*(.+)$/i);
    if (actionMatch) {
      const rawWithDeadline = actionMatch[1].trim();
      const due = rawWithDeadline.match(/\s+(?:by|due)\s+(.+)$/i);
      const deadlineText = due?.[1]?.trim();
      const raw = due ? rawWithDeadline.slice(0, due.index).trim() : rawWithDeadline;
      const senderName = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender))?.name ?? "";
      // "Name to <description>" pattern
      const nameToMatch = raw.match(/^(.+?)\s+to\s+(.+)$/i);
      // "<description> for <Name>" pattern
      const forNameMatch = raw.match(/^(.+?)\s+for\s+(.+)$/i);
      let description = raw;
      let assigneeReference: string | undefined;
      if (nameToMatch) {
        assigneeReference = nameToMatch[1].trim();
        description = nameToMatch[2].trim();
      } else if (forNameMatch) {
        description = forNameMatch[1].trim();
        assigneeReference = forNameMatch[2].trim();
      }
      await this.deps.createActionFromExplicit.execute({
        conversationId: convId, creatorId: sender, authorName: senderName,
        rawMessageId: wireMessage.id,
        description: restoreLabels(description),
        assigneeReference: assigneeReference ? restoreLabels(assigneeReference) : undefined,
        assigneeId: mentionBindings?.owner(assigneeReference)?.userId,
        deadlineText: deadlineText ? restoreLabels(deadlineText) : undefined,
      });
      return;
    }

    // decisions about / search decisions <query>
    const decisionsSearchMatch = commandText.match(/^(?:decisions?\s+(?:about|on|for|regarding)|search\s+decisions?)\s+(.+)$/i);
    if (decisionsSearchMatch) {
      await this.deps.searchDecisions.execute({
        conversationId: convId, searchText: decisionsSearchMatch[1].trim(), replyToMessageId: wireMessage.id,
      });
      return;
    }

    // remind me <time-expression> to <description>
    // Also handles: "make/set/create/add a reminder for <time> that/to <desc>"
    const remindMatch = commandText.match(/^remind(?:\s+me)?\s+(.+?)\s+to\s+(.+)$/i)
                     ?? commandText.match(/^reminder\s+(.+?)\s+to\s+(.+)$/i)
                     ?? commandText.match(/^(?:make|set|create|add)\s+(?:a\s+)?reminder\s+for\s+(.+?)\s+(?:that|to)\s+(.+)$/i)
                     ?? commandText.match(/^(?:make|set|create|add)\s+(?:a\s+)?reminder\s+(.+?)\s+(?:that|to)\s+(.+)$/i);
    if (remindMatch) {
      const config = await this.deps.conversationConfig.get(convId);
      const parsed = this.deps.dateTimeService.parse(remindMatch[1].trim(), { timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC" });
      if (!parsed?.value) {
        await this.deps.wireOutbound.sendPlainText(convId,
          `I'm afraid I couldn't parse _"${remindMatch[1].trim()}"_ as a time. Try: _"remind me at 3pm to call John"_ or _"remind me in 2 hours to check the build"_.`,
          { replyToMessageId: wireMessage.id });
        return;
      }
      await this.deps.createReminder.execute({
        conversationId: convId, authorId: sender, authorName: senderDisplayName ?? "",
        rawMessageId: wireMessage.id,
        description: remindMatch[2].trim(), targetId: sender, triggerAt: parsed.value, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC",
      });
      return;
    }

    // Retired TASK-* fast-paths — redirect to actions
    if (/^(?:TASK-\d+\s+.+|(?:done|close|complete|cancel|cancelled|in[_\s]progress)\s+TASK-\d+)/i.test(commandText)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid tasks have been consolidated into actions. Please use _ACT-NNNN_ identifiers going forward.",
        { replyToMessageId: wireMessage.id });
      return;
    }

    // List commands — use commandLowered so "@Wire Team Bot (DEV) show reminders" routes
    // the same as the bare plain-text equivalent.  Natural-language variants are
    // matched here so they are handled regardless of whether @Wire Team Bot was mentioned.
    if (commandLowered === "my actions" || commandLowered === "my action"
        || /^(?:what\s+are\s+(?:my|all\s+my)|show\s+(?:me\s+)?my|list\s+my)\s+(?:open\s+|current\s+)?actions?\s*[?]?$/i.test(commandLowered)
        || /^(?:do\s+i\s+have\s+(?:any\s+)?(?:open\s+)?actions?)\s*[?]?$/i.test(commandLowered)) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.listMyActions.execute({ conversationId: convId, assigneeId: sender, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id });
      return;
    }
    if (commandLowered === "team actions" || commandLowered === "team action") {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.listTeamActions.execute({ conversationId: convId, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id });
      return;
    }
    if (commandLowered === "overdue actions" || commandLowered === "overdue" || commandLowered === "overdue tasks") {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.listOverdueActions.execute({ conversationId: convId, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id });
      return;
    }
    if (commandLowered === "my reminders" || commandLowered === "show reminders" || commandLowered === "list reminders" || commandLowered === "reminders"
        || /^(?:what|show|list|do we have any|any)\s+reminders?(?:\s+do\s+(?:we|i)\s+have)?[?]?$/i.test(commandLowered)
        || /^(?:what\s+reminders\s+do\s+i\s+have)\s*[?]?$/i.test(commandLowered)
        || /^(?:what|show|list)\s+(?:are\s+(?:the|our|my)\s+)?(?:open\s+|pending\s+)?reminders?\s*[?]?$/i.test(commandLowered)) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.listMyReminders.execute({ conversationId: convId, targetId: sender, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id });
      return;
    }
    if (commandLowered === "list decisions" || commandLowered === "decisions" || commandLowered === "decisions list") {
      await this.deps.listDecisions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }

    // Retired task commands — redirect to action equivalents
    if (/^(my tasks?|list my tasks?)$/.test(commandLowered)) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.listMyActions.execute({ conversationId: convId, assigneeId: sender, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id });
      return;
    }
    if (/^(team tasks?|all tasks?|list team tasks?)$/.test(commandLowered)) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.listTeamActions.execute({ conversationId: convId, timezone: config?.timezone ?? this.deps.defaultTimezone ?? "UTC", replyToMessageId: wireMessage.id });
      return;
    }
    if (/^(knowledge|list knowledge|my knowledge|show knowledge)$/.test(commandLowered)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid the knowledge base has been reorganised. Ask me a question directly and I shall do my best to assist.",
        { replyToMessageId: wireMessage.id });
      return;
    }
    if (/^(?:forget|update)\s+KB-\d+/i.test(commandText)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid knowledge entries are no longer managed that way. The knowledge system is being rebuilt — do ask me questions directly in the meantime.",
        { replyToMessageId: wireMessage.id });
      return;
    }

    const addressedAction = isBotAddressed ? parseAddressedAction(identityText) : null;
    if (addressedAction) {
      await this.deps.createActionFromExplicit.execute({
        ...addressedAction,
        description: restoreLabels(addressedAction.description),
        assigneeReference: restoreLabels(addressedAction.assigneeReference),
        assigneeId: mentionBindings?.owner(addressedAction.assigneeReference)?.userId,
        deadlineText: addressedAction.deadlineText ? restoreLabels(addressedAction.deadlineText) : undefined,
        conversationId: convId, creatorId: sender, authorName: senderDisplayName ?? "",
        rawMessageId: wireMessage.id,
      });
      return;
    }

    // ── Follow-up detection ───────────────────────────────────────────────────
    // If Wire Team Bot' most recent message (within the last 3 buffered messages) ended
    // with a question mark, treat the next human message as a follow-up even
    // without an explicit @mention.
    const isFollowUp = (() => {
      if (botMentionedEarly) return false;
      const recent = this.deps.messageBuffer.getLastN(convId, 3);
      // Find the last message Wire Team Bot sent, ignoring the current one (not yet buffered)
      const lastBot = [...recent].reverse().find(m => sameQualifiedId(m.senderId, this.deps.botUserId));
      // Check if the last sentence of Wire Team Bot' message ends with "?" — handles
      // multi-paragraph responses where the offer question isn't the very last line.
      if (lastBot == null) return false;
      const lastSentence = lastBot.text.trim().split(/\n+/).filter(Boolean).pop() ?? "";
      return lastSentence.trimEnd().endsWith("?");
    })();

    // A message that displaced the requester's offer is about that offer, even when the offer
    // came from passive help and is not in the conversation buffer, so a correction ("the
    // description should mention X", "also add the comment 'thanks'") reaches the answer path
    // to be revised.
    const amendsOffer = droppedOffer?.kind === "support" || droppedOffer?.kind === "reply" || droppedOffer?.kind === "resolve";

    // ── @Wire Team Bot mention or follow-up — answer question ────────────────────────
    const amendOnly = amendsOffer && !botMentionedEarly && !isFollowUp;
    if (botMentionedEarly || isFollowUp || amendsOffer) {
      log.info("Message: dispatched to answerQuestion", { isFollowUp, amendsOffer });
      const config = await this.deps.conversationConfig.get(convId);
      const recentContext = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW).slice(0, -1).map((m) =>
        m.senderName ? `${m.senderName}: ${m.text}` : m.text,
      );
      const orgId = this.deps.orgId ?? convId.domain;
      const isPersonal = this.personalModeCache.get(channelId) ?? false;
      const answer = await this.deps.answerQuestion.execute({
        question: commandText,
        requester: { id: sender.id, domain: sender.domain, name: senderDisplayName },
        conversationContext: recentContext,
        conversationId: convId,
        replyToMessageId: wireMessage.id,
        members,
        conversationPurpose: config?.purpose,
        channelId,
        orgId,
        userId: isPersonal ? sender.id : undefined,
        ...(droppedOffer ? { pendingOffer: droppedOffer } : {}),
        ...(amendOnly ? { amendOnly: true } : {}),
        timezone: config?.timezone ?? this.deps.defaultTimezone,
      });
      // Not a revision: the message was ordinary conversation, so it continues to capture.
      if (amendOnly && !answer) {
        this.enqueueForPipeline(wireMessage, text, convId, sender, channelId, senderDisplayName, log);
        return;
      }
      // Push Wire Team Bot' response into both buffers so follow-up messages have context.
      const botMsgId = `bot-${Date.now()}`;
      this.deps.messageBuffer.push(convId, {
        messageId: botMsgId,
        senderId: this.deps.botUserId,
        senderName: "Wire Team Bot",
        text: answer,
        timestamp: new Date(),
      });
      return;
    }
    // ── ACTIVE — enqueue background pipeline job ──────────────────────────────
    // Skip explicit command messages (decision:, action:) — those are persisted
    // synchronously by the command handlers below.  Re-processing them through
    // the extraction pipeline creates duplicate entities in the database.
    this.enqueueForPipeline(wireMessage, text, convId, sender, channelId, senderDisplayName, log);
  }

  private enqueueForPipeline(
    wireMessage: TextMessage,
    text: string,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    senderDisplayName: string | undefined,
    log: Logger,
  ): void {
    const isExplicitCommand = /^(?:decision|action):\s/i.test(text.trim());
    if (!isExplicitCommand && this.deps.processingQueue && this.deps.pipeline) {
      log.info("Message: enqueued for pipeline processing");
      const orgId = this.deps.orgId ?? convId.domain;
      const job: MessageJob = {
        messageId: wireMessage.id,
        channelId,
        conversationId: convId,
        senderId: sender,
        senderName: senderDisplayName ?? "",
        text,
        timestamp: new Date(),
        orgId,
      };
      this.deps.processingQueue.enqueue({
        id: wireMessage.id,
        channelId,
        payload: job,
        enqueuedAt: new Date(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Channel state machine
  // ─────────────────────────────────────────────────────────────────────────

  private async setChannelState(
    convId: QualifiedId,
    channelId: string,
    newState: "active" | "paused" | "secure",
    actorId: string,
    replyToMessageId: string,
    log: Logger,
  ): Promise<void> {
    const now = new Date();
    const prevState = this.channelStateCache.get(channelId) ?? "active";
    // Stop locally first. Resume only after the durable state write succeeds.
    this.channelStateCache.set(channelId, "paused");
    this.deps.messageBuffer.clear(convId);
    this.deps.pendingOffers?.clearConversation(convId);
    this.deps.slidingWindow.flush(channelId);
    await this.deps.processingQueue?.cancelChannel(channelId);
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      if (!existing) {
        await this.deps.channelConfig.upsert({ channelId, organisationId: convId.domain,
          state: "paused", secureRanges: [], timezone: this.deps.defaultTimezone ?? "UTC", locale: "en" });
      }
      await this.deps.channelConfig.setState(channelId, newState, actorId, now);
      if (newState === "secure") await this.deps.channelConfig.openSecureRange(channelId, now);
      else if (prevState === "secure") await this.deps.channelConfig.closeSecureRange(channelId, now);
      this.channelStateCache.set(channelId, newState);
    } catch {
      log.error("Channel state persistence failed; processing remains blocked locally");
      await this.deps.wireOutbound.sendPlainText(convId,
        "Processing is stopped in this process, but I could not save the state. Retry the control command before restarting the bot.",
        { replyToMessageId });
      return;
    }

    if (newState === "secure") {
      this.deps.slidingWindow.flush(channelId);
      this.scheduleInactivityCheck(convId, channelId);
      await this.deps.wireOutbound.sendPlainText(convId,
        "Of course. I have cleared my short-term recollection of this channel and shall disregard all proceedings until further notice.",
        { replyToMessageId });
    } else if (newState === "paused") {
      this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
      await this.deps.wireOutbound.sendPlainText(convId,
        "Understood. I shall step out. Do let me know when you require my attention again.",
        { replyToMessageId });
    } else {
      this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
      await this.deps.wireOutbound.sendPlainText(convId, "Listening has resumed. I am active again.", { replyToMessageId });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context command handler
  // ─────────────────────────────────────────────────────────────────────────

  private async handleContextCommand(
    match: ContextCommandMatch,
    convId: QualifiedId,
    channelId: string,
    sender: QualifiedId,
    replyToMessageId: string,
    log: Logger,
  ): Promise<void> {
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      const base = existing ?? {
        channelId, organisationId: convId.domain, state: "active" as const,
        secureRanges: [], timezone: this.deps.defaultTimezone ?? "UTC", locale: "en",
      };
      const updated = { ...base, contextUpdatedAt: new Date(), contextUpdatedBy: sender.id };

      switch (match.field) {
        case "purpose":   updated.purpose = match.value; break;
        case "type":      updated.contextType = match.value as "customer" | "project" | "team" | "general"; break;
        case "tags":      updated.tags = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean); break;
        case "stakeholders": updated.stakeholders = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean); break;
        case "related":   updated.relatedChannels = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean); break;
      }

      await this.deps.channelConfig.upsert(updated);

      if (match.field === "purpose") {
        const legacyCfg = await this.deps.conversationConfig.get(convId);
        await this.deps.conversationConfig.upsert({
          conversationId: convId,
          timezone: legacyCfg?.timezone ?? "UTC",
          locale: legacyCfg?.locale ?? "en",
          secretMode: legacyCfg?.secretMode ?? false,
          implicitDetectionEnabled: legacyCfg?.implicitDetectionEnabled,
          sensitivity: legacyCfg?.sensitivity,
          purpose: match.value,
          raw: legacyCfg?.raw ?? null,
        });
      }

      await this.deps.wireOutbound.sendPlainText(convId, "Noted. Context updated.", { replyToMessageId });
    } catch (err) {
      log.warn("Failed to update channel context", { err: (err instanceof Error ? err.name : "UnknownError") });
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid I was unable to update the channel context just now.", { replyToMessageId });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inactivity check (SECURE mode only)
  // ─────────────────────────────────────────────────────────────────────────

  private scheduleInactivityCheck(convId: QualifiedId, channelId: string): void {
    this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
    this.deps.scheduler.schedule({
      id: `secret-inactivity-${channelId}`, type: "secret_inactivity",
      runAt: new Date(Date.now() + this.deps.secretModeInactivityMs),
      payload: { convId },
    });
  }

  async handleSecretModeInactivityCheck(convId: QualifiedId): Promise<void> {
    const channelId = toChannelId(convId);
    if (this.channelStateCache.get(channelId) !== "secure") return;
    const lastActivity = this.lastActivityByConv.get(channelId) ?? 0;
    const inactiveMs = Date.now() - lastActivity;
    if (inactiveMs >= this.deps.secretModeInactivityMs) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "This conversation has been quiet for a while. Mention me with _\"resume\"_ whenever you'd like me to start listening again.");
    } else {
      this.deps.scheduler.schedule({
        id: `secret-inactivity-${channelId}`, type: "secret_inactivity",
        runAt: new Date(lastActivity + this.deps.secretModeInactivityMs),
        payload: { convId },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Button actions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A photo or document posted in the channel (customer demo): with passive help on and an open
   * support request, the bot offers to attach it. Runs in the channel's message order and
   * under the same state gate as text. Wire sends a preview before the upload with the same
   * message ID; only the uploaded event (with download data) counts, once.
   */
  async onAssetMessageReceived(wireMessage: AssetMessage): Promise<void> {
    const channelId = toChannelId(wireMessage.conversationId);
    const previous = this.handlers.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      const process = () => this.processAssetMessage(wireMessage);
      return this.deps.replyContext ? this.deps.replyContext.withMessage(wireMessage, process) : process();
    });
    this.handlers.set(channelId, current);
    try { await current; } finally {
      if (this.handlers.get(channelId) === current) this.handlers.delete(channelId);
    }
  }

  private async processAssetMessage(wireMessage: AssetMessage): Promise<void> {
    const offerAttachment = this.deps.offerAttachment;
    const sender = wireMessage.sender as QualifiedId | undefined;
    if (!offerAttachment || !sender || sameQualifiedId(sender, this.deps.botUserId)) return;
    // No download data yet (the preview), or a self-deleting message, whose timer Wire must be able to keep.
    if (!wireMessage.remoteData || wireMessage.expiresAfterMillis) return;
    const fileKind = attachableKind(wireMessage.mimeType);
    const sizeInBytes = Number(wireMessage.sizeInBytes);
    if (!fileKind || !Number.isFinite(sizeInBytes) || sizeInBytes <= 0 || sizeInBytes > ATTACHMENT_MAX_BYTES) return;
    if (!this.firstSightOfAsset(wireMessage.id)) return;

    const convId = wireMessage.conversationId as QualifiedId;
    const channelId = toChannelId(convId);
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: sender.id, messageId: wireMessage.id });
    this.lastActivityByConv.set(channelId, Date.now());
    if (!this.knownConvs.has(channelId)) {
      this.knownConvs.add(channelId);
      await this.hydrateChannelState(convId, channelId, log);
    }
    if ((this.channelStateCache.get(channelId) ?? "active") !== "active") {
      log.debug("Channel not active — file ignored");
      return;
    }

    const name = wireMessage.name?.trim() || (fileKind === "photo" ? "photo" : "file");
    try {
      const offered = await offerAttachment.execute({
        conversationId: convId, senderId: sender, messageId: wireMessage.id,
        file: { ref: { transport: "wire", data: wireMessage.remoteData }, fileKind, name, mimeType: wireMessage.mimeType, sizeInBytes },
      });
      log.debug("File received", { fileKind, offered });
    } catch (err) {
      log.error("File handler failed", { err: err instanceof Error ? err.name : "UnknownError" });
      return;
    }
    // Context for the next text message, without the file's name or content.
    const senderName = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender))?.name ?? "";
    this.deps.messageBuffer.push(convId, {
      messageId: wireMessage.id, senderId: sender, senderName, text: fileKind === "photo" ? "(photo)" : "(file)", timestamp: new Date(),
    });
  }

  /** Recent file message IDs, so a repeated event is handled once; bounded. */
  private readonly seenAssets = new Set<string>();

  private firstSightOfAsset(messageId: string): boolean {
    if (this.seenAssets.has(messageId)) return false;
    this.seenAssets.add(messageId);
    if (this.seenAssets.size > 500) this.seenAssets.delete(this.seenAssets.values().next().value!);
    return true;
  }

  async onTextMessageEdited(_wireMessage: TextEditedMessage): Promise<void> {
    // Edits are intentionally ignored — re-processing an edited message would
    // re-extract actions/decisions from the sliding window and create duplicates.
  }

  async onButtonClicked(wireMessage: CompositeButtonAction): Promise<void> {
    const convId = wireMessage.conversationId as QualifiedId;
    const senderId = wireMessage.sender as QualifiedId;
    const { buttonId, referenceMessageId } = wireMessage;
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: senderId.id, buttonId });

    switch (buttonId) {
      default:
        await this.deps.wireOutbound.sendPlainText(convId, "This button is no longer supported. Use a text command, for example: action: review the decision for Bob.");
    }

    try {
      const confirmation: ButtonActionConfirmation = {
        type: "composite_button_action_confirmation",
        id: randomUUID(),
        conversationId: convId,
        referenceMessageId,
        buttonId,
      };
      await this.manager.sendMessage(confirmation);
      log.debug("Button action confirmation sent", { referenceMessageId });
    } catch (err) {
      // Also reached in unit tests where the SDK manager is not wired; harmless there.
      log.warn("Failed to send button action confirmation", { err: (err instanceof Error ? err.name : "UnknownError") });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Startup hydration — called once after the SDK is initialised
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pre-populate the member cache from the SDK's persisted conversation store so that
   * display names are available before the first message arrives after a restart.
   *
   * onAppAddedToConversation only fires when the bot is first added to a conversation,
   * not on subsequent restarts. This method covers that gap using the SDK's public
   * getAllConversations() / getMembersInConversation() API.
   *
   * Awaiting this before startListening() ensures no message arrives with an empty cache.
   */
  async hydrateFromSdkStore(
    conversations: Conversation[],
    getMembers: (conv: Conversation) => Promise<ConversationMember[]>,
  ): Promise<void> {
    await Promise.allSettled(
      conversations.map(async (conv) => {
        const convId: QualifiedId = { id: conv.id, domain: conv.domain };
        // Skip if the cache was already populated by a live onAppAddedToConversation event.
        if (this.deps.memberCache.getMembers(convId).length > 0) return;

        const rawMembers = await getMembers(conv);
        const members: CachedMember[] = rawMembers
          .filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId))
          .map((m) => ({
            userId: { id: m.userId.id, domain: m.userId.domain },
            role: toCachedRole(m.role),
          }));

        this.deps.memberCache.setMembers(convId, members);

        // Fetch names now so they're ready for the first arriving message.
        await Promise.allSettled(
          members.map(async (m) => {
            const profile = await this.deps.wireOutbound.getUserProfile(m.userId);
            if (profile?.name) {
              this.deps.memberCache.updateMemberName(convId, m.userId, profile.name, profile.handle);
            }
          }),
        );
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Conversation lifecycle events
  // ─────────────────────────────────────────────────────────────────────────

  async onAppAddedToConversation(conversation: Conversation, members: ConversationMember[]): Promise<void> {
    const convId = { id: conversation.id, domain: conversation.domain } as QualifiedId;
    const channelId = toChannelId(convId);
    this.deps.memberCache.setMembers(convId, members.map((m) => ({
      userId: m.userId as QualifiedId,
      role: toCachedRole(m.role),
    })));

    // Resolve display names for all non-bot members before returning.
    // Awaiting here ensures names are in cache before the first message from
    // any member in this conversation is processed.
    await Promise.allSettled(
      members
        .filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId))
        .map(async (m) => {
          const profile = await this.deps.wireOutbound.getUserProfile(m.userId as QualifiedId);
          if (profile?.name) {
            this.deps.memberCache.updateMemberName(convId, m.userId as QualifiedId, profile.name, profile.handle);
          }
        }),
    );

    const nonBotMembers = members.filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId));
    const isPersonalMode = nonBotMembers.length === 1;
    this.personalModeCache.set(channelId, isPersonalMode);

    try {
      const now = new Date();
      const existing = await this.deps.channelConfig.get(channelId);
      await this.deps.channelConfig.upsert({
        channelId,
        channelName: conversation.name ?? existing?.channelName,
        organisationId: convId.domain,
        state: existing?.state ?? "active",
        secureRanges: existing?.secureRanges ?? [],
        purpose: existing?.purpose,
        contextType: existing?.contextType,
        tags: existing?.tags ?? [],
        stakeholders: existing?.stakeholders ?? [],
        relatedChannels: existing?.relatedChannels ?? [],
        timezone: existing?.timezone ?? this.deps.defaultTimezone ?? "UTC",
        locale: existing?.locale ?? "en",
        joinedAt: existing?.joinedAt ?? now,
        isPersonalMode,
      });
    } catch { /* non-fatal */ }

    try {
      const channelCfg = await this.deps.channelConfig.get(channelId);
      if (!channelCfg?.purpose) {
        const legacyCfg = await this.deps.conversationConfig.get(convId);
        if (!legacyCfg?.purpose) {
          await this.deps.wireOutbound.sendPlainText(
            convId,
            welcomeText(this.deps.supportWelcome),
          );
        }
      }
    } catch { /* non-fatal */ }
  }

  async onConversationDeleted(conversationId: QualifiedId): Promise<void> {
    const channelId = toChannelId(conversationId);
    this.deps.memberCache.clearConversation(conversationId as QualifiedId);
    await this.deps.processingQueue?.cancelChannel(channelId);
    this.deps.messageBuffer.clear(conversationId);
    this.deps.slidingWindow.clear(channelId);
    this.channelStateCache.delete(channelId);
    this.knownConvs.delete(channelId);
  }

  async onUserJoinedConversation(conversationId: QualifiedId, members: ConversationMember[]): Promise<void> {
    this.deps.memberCache.addMembers(conversationId as QualifiedId, members.map((m) => ({
      userId: m.userId as QualifiedId,
      role: toCachedRole(m.role),
    })));
    await this.updatePersonalMode(conversationId as QualifiedId);

    // Resolve names for newly joined members before returning.
    await Promise.allSettled(
      members
        .filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId))
        .map(async (m) => {
          const profile = await this.deps.wireOutbound.getUserProfile(m.userId as QualifiedId);
          if (profile?.name) {
            this.deps.memberCache.updateMemberName(conversationId as QualifiedId, m.userId as QualifiedId, profile.name, profile.handle);
          }
        }),
    );
  }

  async onUserLeftConversation(conversationId: QualifiedId, members: QualifiedId[]): Promise<void> {
    this.deps.memberCache.removeMembers(conversationId as QualifiedId, members as QualifiedId[]);
    await this.updatePersonalMode(conversationId as QualifiedId);
  }

  private async updatePersonalMode(convId: QualifiedId): Promise<void> {
    const channelId = toChannelId(convId);
    const allMembers = this.deps.memberCache.getMembers(convId);
    const nonBotMembers = allMembers.filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId));
    const isPersonalMode = nonBotMembers.length === 1;
    this.personalModeCache.set(channelId, isPersonalMode);
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      if (existing) await this.deps.channelConfig.upsert({ ...existing, isPersonalMode });
    } catch { /* non-fatal */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command matchers
  // ─────────────────────────────────────────────────────────────────────────

  private startsWithBotName(lowered: string): boolean {
    return /^@?(?:wire team bot)\b/i.test(lowered);
  }

  private stripAddressedBotPrefix(text: string, message: TextMessage): string {
    // Wire protobuf mention offsets count UTF-16 code units, as does JS slice.
    // Use the qualified mention identity; registered app labels can change.
    const mention = message.mentions?.find(m =>
      sameQualifiedId(m.userId, this.deps.botUserId)
      && Number.isInteger(m.offset) && Number.isInteger(m.length)
      && m.offset >= 0 && m.length > 0 && m.offset + m.length <= text.length
      && text.slice(0, m.offset).trim() === "" && text[m.offset] === "@",
    );
    if (mention) return text.slice(mention.offset + mention.length).replace(/^[,:]?\s*/, "").trim();
    return this.stripBotPrefix(text);
  }

  private stripBotPrefix(lowered: string): string {
    // Strip @Wire Team Bot or Wire Team Bot, optionally followed by a parenthetical display-name
    // suffix like (DEV) or (Staging), then any trailing comma/colon and whitespace.
    return lowered.replace(/^@?(?:wire team bot)(?:\s+\([^)]+\))?[,:]?\s*/i, "").trim();
  }

  private matchesPauseCommand(lowered: string): boolean {
    const s = this.stripBotPrefix(lowered);
    return /^(pause|step out)(\s+please)?$/.test(s) || /^(pause|step out)(\s+please)?$/.test(lowered);
  }

  private matchesResumeCommand(lowered: string): boolean {
    const s = this.stripBotPrefix(lowered);
    return /^(resume|come back)(\s+please)?$/.test(s) || /^(resume|come back)(\s+please)?$/.test(lowered);
  }

  private matchesSecureCommand(lowered: string): boolean {
    const s = this.stripBotPrefix(lowered);
    // "safe mode" is accepted as a natural-language alias for "secure mode".
    return /^(secure mode|safe mode|ears off|secure|safe)(\s+please)?$/.test(s)
        || /^(secure mode|safe mode|ears off)(\s+please)?$/.test(lowered);
  }

  private matchContextCommand(text: string): ContextCommandMatch | null {
    const command = this.stripBotPrefix(text);
    const m = (re: RegExp, field: ContextField) => { const r = command.match(re); return r ? { field, value: r[1].trim() } : null; };
    return m(/^context:\s*(.+)$/i, "purpose")
      ?? m(/^context\s+type:\s*(.+)$/i, "type")
      ?? m(/^context\s+tags:\s*(.+)$/i, "tags")
      ?? m(/^context\s+stakeholders:\s*(.+)$/i, "stakeholders")
      ?? m(/^context\s+related:\s*(.+)$/i, "related")
      ?? null;
  }

}

type ContextField = "purpose" | "type" | "tags" | "stakeholders" | "related";
interface ContextCommandMatch { field: ContextField; value: string; }
