import type { GeneralAnswerService, ConversationMemberContext } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort, OutboundMention } from "../../ports/WireOutboundPort";
import type { QueryAnalysisPort, MemberContext } from "../../ports/QueryAnalysisPort";
import type { RetrievalPort, RetrievalResult, RetrievalScope } from "../../ports/RetrievalPort";
import type { ChannelContext } from "../../ports/ClassifierPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject } from "../../../domain/ids/jiraLink";
import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { Logger } from "../../ports/Logger";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import { GENERIC_COMMAND_LINE, NO_CHANGE_REPLY, OFFER_TTL_MS, formatSupportQuestion, offerCommandLine, parseOfferMarker } from "../../services/offers";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../services/offers";
import { botActor, refreshStatusCategory } from "../jira/supportRequestStatus";
import { formatSla, statusLabel } from "../jira/formatIssue";
import { findSupportRequestInConversation } from "../jira/supportRequestScope";

/**
 * Scans `text` for `@Name` tokens and returns Wire mention objects with UTF-16 offsets.
 * Only members that have both a name and a domain are eligible.
 */
function extractMentions(text: string, members: ConversationMemberContext[]): OutboundMention[] {
  const mentions: OutboundMention[] = [];
  for (const member of members) {
    if (!member.name || !member.domain) continue;
    const token = `@${member.name}`;
    let idx = text.indexOf(token);
    while (idx !== -1) {
      mentions.push({
        userId: { id: member.id, domain: member.domain },
        offset: idx,
        length: token.length,
      });
      idx = text.indexOf(token, idx + 1);
    }
  }
  return mentions;
}

export interface AnswerQuestionInput {
  question: string;
  conversationContext: string[];
  conversationId: QualifiedId;
  replyToMessageId: string;
  members?: ConversationMemberContext[];
  /** Authoritative sender of this question, independent of recent participants. */
  requester?: ConversationMemberContext;
  conversationPurpose?: string;
  /** Phase 3: channel_id string for retrieval scoping. */
  channelId?: string;
  /** Phase 3: Wire domain / org scope for retrieval. */
  orgId?: string;
  /** Phase 3: Defined in personal 1:1 mode — restricts retrieval to user's own entities. */
  userId?: string;
  /**
   * The requester's offer that this message just displaced (dropped by the router), so a
   * correction such as "the description should mention X" can produce a revised offer.
   */
  pendingOffer?: OfferCommand;
  /**
   * The message reached the answer path only because it followed the requester's offer, not
   * because the bot was addressed. Nothing is sent unless it revises that offer; an empty
   * string is returned so the router can treat it as ordinary conversation.
   */
  amendOnly?: boolean;
}

/**
 * Jira support for the answer path. Stored support requests of this conversation are always
 * added to the results; live ticket content is fetched only when `shareWithModel` is true.
 */
export interface AnswerQuestionJira {
  tracker: IssueTrackerPort;
  requests: SupportRequestRepository;
  /** Records the status refresh after a live read shows a changed category. */
  auditLog: AuditLogRepository;
  offers: PendingOfferStore;
  /** Pass live status, SLAs and service-desk replies of this conversation's support requests to the answer model. */
  shareWithModel: boolean;
  now?: () => Date;
}

/** Newest stored support requests of the conversation added to the results. */
const STORED_REQUESTS_SHARED = 10;
/** Keys named in the question that are looked up through the scope helper. */
const NAMED_KEYS_CHECKED = 5;
/** Tickets whose live data is passed to the model. */
const TICKETS_SHARED = 3;
const REPLIES_SHARED = 3;
const SHARED_REPLY_MAX = 500;
const FALLBACK_ANSWER = "I wasn't able to generate a response.";

/**
 * Questions that may need live ticket data: Jira, service-desk or support wording, or asking
 * for the status or news of something. Other questions make no tracker call. A named project
 * key also counts (see `asksAboutTickets`).
 */
const TICKET_QUESTION = /\b(?:jira|tickets?|service\s+desk|support|requests?|issues?|slas?|repl(?:y|ies)|status|latest|news|updates?|progress|heard|answers?)\b/i;

/*
 * Change intent that the requester's own question must express before a model offer is
 * accepted. The model is untrusted and, with sharing on, reads customer-written ticket text,
 * so an offer on a question that asks for no change ("what did we decide about lunch?") is
 * dropped. A named project key also counts as a reply target (see `asksForChange`).
 */
/**
 * support: a raising verb ("raise", "open", "create", "file", "log", "submit", "report",
 * "escalate", "put ... into") followed by a service-desk target ("service desk", "support",
 * "ticket", "request", "Jira", "it with"), or "raise it"/"report it". A question about an
 * existing request ("any news on my ticket?", "is my ticket still open?") names no raising verb
 * before the target, so it does not pass.
 */
const SUPPORT_INTENT = /\b(?:raise|open|create|file|log(?!\s+(?:in|into|on)\b)|submit|report|escalate|put\b[^.?!]*\binto)\b[^.?!]*\b(?:service\s+desk|support|tickets?|requests?|jira|it\s+with)\b|\b(?:raise|report)\s+(?:it|this)\b/i;
/** resolve: "close", "resolve", "works again", "working again", "no longer needed" and their inflections. */
const RESOLVE_INTENT = /\b(?:clos(?:e|es|ed|ing)|resolv(?:e|es|ed|ing)|(?:works?|working)\s+again|no\s+longer\s+(?:needed|necessary|required))\b/i;
/** reply, first part: a verb of sending a message ("reply", "tell", "send", "let ... know", "message", "answer"). */
const REPLY_VERB = /\b(?:repl(?:y|ies|ied|ying)|tell|send|let\b.*\bknow|message|answer)\b/i;
/** reply, second part: the service desk as recipient. */
const REPLY_TARGET = /\b(?:service\s+desk|support|jira|tickets?)\b/i;

/** A validated offer and the code-written question that asks the requester to confirm it. */
interface PreparedOffer {
  question: string;
  offer: PendingOffer;
}

/** Live data for one support request, and its record when the read refreshed the stored category. */
interface LiveTicket {
  result: RetrievalResult;
  refreshed: SupportRequest | null;
}

/**
 * Answers a general question using the LLM.
 *
 * When queryAnalysis and retrievalEngine are provided (Phase 3):
 *   1. Analyse the question into a QueryPlan via QueryAnalysisPort
 *   2. Run MultiPathRetrievalEngine to gather relevant context
 *   3. Pass retrieval results + complexity to GeneralAnswerService
 *
 * When retrieval engine is absent (backwards-compatible):
 *   - Falls back to empty context (Phase 1b behaviour).
 *
 * When Jira support is provided, the stored support requests of this conversation are added
 * to the results, live data for some of them is added only with sharing enabled, and a
 * model-proposed offer is validated by code and turned into a code-written confirmation
 * question. This path never writes to Jira; its only record write is the status refresh.
 */
export class AnswerQuestion {
  constructor(
    private readonly generalAnswer: GeneralAnswerService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly queryAnalysis?: QueryAnalysisPort,
    private readonly retrievalEngine?: RetrievalPort,
    private readonly logger?: Logger,
    private readonly jira?: AnswerQuestionJira,
  ) {}

  async execute(input: AnswerQuestionInput): Promise<string> {
    let retrievalResults: RetrievalResult[] = [];
    let complexity = 0.5;

    if (
      this.queryAnalysis &&
      this.retrievalEngine &&
      input.channelId &&
      input.orgId
    ) {
      const channelContext: ChannelContext = {
        channelId: input.channelId,
        purpose: input.conversationPurpose,
      };

      const members: MemberContext[] = (input.members ?? []).map((m) => ({
        id: m.id,
        domain: m.domain,
        name: m.name,
      }));

      try {
        const plan = await this.queryAnalysis.analyse(
          input.question,
          channelContext,
          members,
          input.requester,
        );
        complexity = plan.complexity;

        const scope: RetrievalScope = {
          organisationId: input.orgId,
          channelId: input.channelId,
          userId: input.userId,
        };

        retrievalResults = await this.retrievalEngine.retrieve(plan, scope);
      } catch (err) {
        // Non-fatal — answer with empty context rather than failing
        this.logger?.warn("AnswerQuestion: retrieval failed, answering with no context", { err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }

    if (this.jira) {
      retrievalResults = [...retrievalResults, ...(await this.supportRequestContext(this.jira, input))];
      const amended = amendableOffer(input.pendingOffer);
      if (amended) retrievalResults.push(pendingOfferResult(amended, input.channelId, (this.jira.now ?? (() => new Date()))()));
    }

    const modelAnswer = await this.generalAnswer.answer(
      input.question,
      input.conversationContext,
      retrievalResults,
      input.members,
      input.conversationPurpose,
      complexity,
      input.requester,
    );

    if (!this.jira) {
      await this.send(input, modelAnswer, true);
      return modelAnswer;
    }

    // The raw marker is never sent, whether or not the offer is valid.
    const parsed = parseOfferMarker(modelAnswer);
    const text = parsed.text || FALLBACK_ANSWER;
    const prepared = parsed.command ? await this.prepareOffer(this.jira, input, parsed.command) : null;
    if (input.amendOnly && !(prepared && parsed.command && isRevision(input.pendingOffer, parsed.command)
        && !sameCommand(input.pendingOffer, parsed.command))) {
      // Unaddressed chat after an offer ("lunch at noon?") is not for the bot, and repeating the
      // same offer would make it follow every message; only a real revision is sent.
      return "";
    }
    if (!prepared && parsed.hadMarker) {
      // The model meant to propose a change that code did not accept. Its text may claim the
      // change ("Updated with that detail."), so only a code-written reply is sent.
      const line = parsed.command ? offerCommandLine(parsed.command, this.jira.tracker.projectKey) : GENERIC_COMMAND_LINE;
      const reply = `${NO_CHANGE_REPLY}\n${line}`;
      await this.send(input, reply, false);
      return reply;
    }
    if (!prepared) {
      await this.send(input, text, true);
      return text;
    }

    // Only the code-written question is sent: the model's own lead-in can imply the change
    // already happened ("I'll send that ..."), which is wrong until the requester confirms.
    // No mentions: a quoted summary or reply body may contain @names that must not ping members.
    // The offer is stored only after the question was sent, so it is never confirmable unseen.
    await this.send(input, prepared.question, false);
    this.jira.offers.put(prepared.offer);
    return prepared.question;
  }

  private async send(input: AnswerQuestionInput, text: string, withMentions: boolean): Promise<void> {
    const mentions = withMentions ? extractMentions(text, input.members ?? []) : [];
    await this.wireOutbound.sendPlainText(input.conversationId, text, {
      replyToMessageId: input.replyToMessageId,
      mentions: mentions.length > 0 ? mentions : undefined,
    });
  }


  /**
   * Support requests of this conversation for the model: the stored records (keys named in the
   * question first, then the newest ones), independent of sharing, and, with sharing on and a
   * ticket-type question, live data for at most three of them. Named keys go through the scope
   * helper, so another channel's key is neither shown nor fetched.
   */
  private async supportRequestContext(jira: AnswerQuestionJira, input: AnswerQuestionInput): Promise<RetrievalResult[]> {
    const projectKey = jira.tracker.projectKey;
    const named: SupportRequest[] = [];
    let recent: SupportRequest[] = [];
    try {
      for (const key of namedKeys(input.question, projectKey).slice(0, NAMED_KEYS_CHECKED)) {
        const request = await findSupportRequestInConversation(jira.requests, key, input.conversationId, projectKey);
        if (request) named.push(request);
      }
      recent = inConversation(await jira.requests.listByConversation(input.conversationId, { limit: STORED_REQUESTS_SHARED }), input.conversationId, projectKey);
    } catch (err) {
      this.logger?.warn("AnswerQuestion: support request lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
    const known = uniqueByKey([...named, ...recent]);
    if (!jira.shareWithModel || !asksAboutTickets(input.question, projectKey)) {
      return known.map((request) => storedRequestResult(request, input.channelId));
    }

    let open: SupportRequest[] = [];
    try {
      open = inConversation(await jira.requests.listByConversation(input.conversationId, { openOnly: true, limit: TICKETS_SHARED }), input.conversationId, projectKey)
        .filter((request) => request.statusCategory !== "done");
    } catch (err) {
      this.logger?.warn("AnswerQuestion: support request lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
    const live = await this.liveTickets(jira, input, uniqueByKey([...named, ...open]).slice(0, TICKETS_SHARED));
    // A refreshed record replaces the stored one, so the model never sees a stale category next to live data.
    for (const { refreshed } of live) {
      if (!refreshed) continue;
      const index = known.findIndex((request) => request.key === refreshed.key);
      if (index >= 0) known[index] = refreshed;
    }
    return [...known.map((request) => storedRequestResult(request, input.channelId)), ...live.map((ticket) => ticket.result)];
  }

  /**
   * Live status, SLAs and public service-desk replies of the given support requests (the port
   * never returns internal notes). A read that shows a changed category refreshes the stored
   * one. The content goes to the model only; it is never stored or logged.
   */
  private async liveTickets(jira: AnswerQuestionJira, input: AnswerQuestionInput, requests: readonly SupportRequest[]): Promise<LiveTicket[]> {
    const now = (jira.now ?? (() => new Date()))();
    const tickets = await Promise.all(requests.map(async (request): Promise<LiveTicket | null> => {
      let snapshot: IssueSnapshot | null;
      let replies: IssueReply[];
      try {
        [snapshot, replies] = await Promise.all([
          jira.tracker.getIssue(request.key),
          jira.tracker.listCustomerReplies(request.key, REPLIES_SHARED),
        ]);
      } catch (err) {
        this.logger?.warn("AnswerQuestion: ticket read failed", trackerErrorFields(err));
        return null;
      }
      if (!snapshot) return null;
      return {
        result: {
          id: request.key,
          type: "jira_ticket",
          content: ticketContent(snapshot, replies),
          sourceChannel: input.channelId ?? "",
          sourceDate: now,
          confidence: 1,
          pathsMatched: ["jira"],
        },
        refreshed: await refreshStatusCategory(
          jira.requests, jira.auditLog, request, snapshot.statusCategory, botActor(input.conversationId), this.logger, now,
        ),
      };
    }));
    return tickets.filter((t): t is LiveTicket => t !== null);
  }

  /**
   * Validates a model-proposed offer. Returns the offer with its code-written question, or null
   * when the offer is dropped. Nothing is stored here: the caller stores the offer after sending.
   */
  private async prepareOffer(jira: AnswerQuestionJira, input: AnswerQuestionInput, command: OfferCommand): Promise<PreparedOffer | null> {
    // A revision of the offer this message displaced needs no fresh change intent: the
    // original offer established it. Scope and bounds are still checked below.
    if (!isRevision(input.pendingOffer, command) && !asksForChange(command.kind, input.question, jira.tracker.projectKey)) {
      this.logger?.warn("AnswerQuestion: offer dropped, the question asks for no change", { kind: command.kind });
      return null;
    }

    const requester = input.requester;
    let question: string | null = null;
    if (requester?.domain) {
      try {
        question = await this.offerQuestion(jira, command, input.conversationId);
      } catch (err) {
        this.logger?.warn("AnswerQuestion: offer validation failed", { kind: command.kind, err: err instanceof Error ? err.name : "UnknownError" });
        return null;
      }
    }
    if (!question || !requester?.domain) {
      this.logger?.warn("AnswerQuestion: offer dropped", { kind: command.kind });
      return null;
    }

    const now = (jira.now ?? (() => new Date()))();
    return {
      question,
      offer: {
        command,
        conversationId: input.conversationId,
        requesterId: { id: requester.id, domain: requester.domain },
        createdAt: now,
        expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      },
    };
  }

  /**
   * Validates the proposed command against the records; returns the question, or null when invalid.
   * Every question ends with "?" so the router treats a non-exact answer as a follow-up.
   */
  private async offerQuestion(jira: AnswerQuestionJira, command: OfferCommand, conversationId: QualifiedId): Promise<string | null> {
    if (command.kind === "support") return formatSupportQuestion(command.summary, command.description);

    const request = await findSupportRequestInConversation(jira.requests, command.issueKey, conversationId, jira.tracker.projectKey);
    if (!request) return null;
    if (command.kind === "reply") {
      const quoted = command.body.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
      return `Here is the reply for **${request.key}**:\n${quoted}\n\nShall I send it (yes or no)?`;
    }
    // A request last known as done is not dropped: the desk may have reopened it, and the use case checks live.
    return `Shall I resolve **${request.key}** "${oneLine(request.summary)}" with the service desk (yes or no)?`;
  }
}

/** Keys of the configured project named in the text, upper-cased, in order, without repeats. */
function namedKeys(text: string, projectKey: string): string[] {
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}-\\d+\\b`, "gi");
  const keys: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const key = match[0].toUpperCase();
    if (isKeyInProject(key, projectKey) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** True when the question may need live ticket data (see `TICKET_QUESTION`). */
function asksAboutTickets(question: string, projectKey: string): boolean {
  return TICKET_QUESTION.test(question) || namedKeys(question, projectKey).length > 0;
}

/** True when the requester's question expresses the change that the offer proposes. */
function asksForChange(kind: OfferCommand["kind"], question: string, projectKey: string): boolean {
  switch (kind) {
    case "support":
      return SUPPORT_INTENT.test(question);
    case "resolve":
      return RESOLVE_INTENT.test(question);
    case "reply":
      return REPLY_VERB.test(question) && (REPLY_TARGET.test(question) || namedKeys(question, projectKey).length > 0);
  }
}

/** The displaced offer when the requester may amend it: only `support` and `reply` offers carry text to correct. */
function amendableOffer(pending: OfferCommand | undefined): OfferCommand | null {
  return pending && (pending.kind === "support" || pending.kind === "reply") ? pending : null;
}

/** True when `command` revises the amendable displaced offer: the same kind and, for a reply, the same request. */
function isRevision(pending: OfferCommand | undefined, command: OfferCommand): boolean {
  const amended = amendableOffer(pending);
  if (!amended || amended.kind !== command.kind) return false;
  return amended.kind !== "reply" || (command.kind === "reply" && amended.issueKey === command.issueKey);
}

/** True when both commands propose exactly the same change. */
function sameCommand(a: OfferCommand | undefined, b: OfferCommand): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** The displaced offer for the model, so the requester's correction can produce a revised offer. */
function pendingOfferResult(command: OfferCommand, channelId: string | undefined, now: Date): RetrievalResult {
  return {
    id: "pending-offer",
    type: "summary",
    content: `Pending offer being amended (not confirmed, nothing was sent; the requester's message changes it): ${JSON.stringify(command)}`,
    sourceChannel: channelId ?? "",
    sourceDate: now,
    confidence: 1,
    pathsMatched: ["pending_offer"],
  };
}

/** Only not-deleted records of this conversation and project, whatever the repository returned. */
function inConversation(requests: readonly SupportRequest[], conversationId: QualifiedId, projectKey: string): SupportRequest[] {
  return requests.filter((request) =>
    !request.deleted && sameQualifiedId(request.conversationId, conversationId) && isKeyInProject(request.key, projectKey));
}

/** The first record per key, in order. */
function uniqueByKey(requests: readonly SupportRequest[]): SupportRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    if (seen.has(request.key)) return false;
    seen.add(request.key);
    return true;
  });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The stored record for the model: key, summary, requester name and last known status only. */
function storedRequestResult(request: SupportRequest, channelId: string | undefined): RetrievalResult {
  const requesterName = request.requesterName.trim();
  return {
    id: request.key,
    type: "support_request",
    content: [
      request.key,
      `Summary: ${oneLine(request.summary)}`,
      ...(requesterName ? [`Requested by: ${requesterName}`] : []),
      `Last known status: ${statusLabel(request.statusCategory)}`,
    ].join(" | "),
    sourceChannel: channelId ?? "",
    sourceDate: request.createdAt,
    confidence: 1,
    pathsMatched: ["support_requests"],
  };
}

/** Compact ticket text for the model. Uses the English status label, never the tracker's status name. */
function ticketContent(snapshot: IssueSnapshot, replies: readonly IssueReply[]): string {
  const replyLines = replies.map((reply) => {
    const author = reply.fromThisBot ? "your team via Wire" : reply.author;
    const body = oneLine(reply.body);
    const text = body.length <= SHARED_REPLY_MAX ? body : `${body.slice(0, SHARED_REPLY_MAX - 3).trimEnd()}...`;
    return `Reply from ${author} at ${reply.created.toISOString()}: ${text}`;
  });
  return [
    `${snapshot.key}: ${snapshot.summary}`,
    `Status: ${statusLabel(snapshot.statusCategory)}`,
    ...snapshot.slas.map(formatSla),
    ...(replyLines.length > 0 ? replyLines : ["No service-desk replies yet."]),
  ].join("\n");
}
