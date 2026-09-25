import type { GeneralAnswerService, ConversationMemberContext } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort, OutboundMention } from "../../ports/WireOutboundPort";
import type { QueryAnalysisPort, MemberContext } from "../../ports/QueryAnalysisPort";
import type { RetrievalPort, RetrievalResult, RetrievalScope } from "../../ports/RetrievalPort";
import type { ChannelContext } from "../../ports/ClassifierPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { JIRA_KEY_PATTERN, isKeyInProject, jiraKeyFromLinks, toJiraLink } from "../../../domain/ids/jiraLink";
import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { Logger } from "../../ports/Logger";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import { OFFER_TTL_MS, parseOfferMarker } from "../../services/offers";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../services/offers";
import { formatSla, statusLabel } from "../jira/formatIssue";

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
}

/** Jira support for the answer path. Ticket content is fetched only when `shareWithModel` is true. */
export interface AnswerQuestionJira {
  tracker: IssueTrackerPort;
  actions: ActionRepository;
  offers: PendingOfferStore;
  /** Pass live status, SLAs and customer replies of linked tickets to the answer model. */
  shareWithModel: boolean;
  now?: () => Date;
}

/** Action results inspected for ticket links. */
const ACTION_RESULTS_INSPECTED = 5;
/** Tickets whose live data is passed to the model. */
const TICKETS_SHARED = 3;
const REPLIES_SHARED = 3;
const SHARED_REPLY_MAX = 500;
const LINK_QUERY_LIMIT = 20;
const FALLBACK_ANSWER = "I wasn't able to generate a response.";

/**
 * Questions that may need live ticket data: Jira or service-desk wording, or asking for the
 * status or news of something. Other questions make no tracker call. A named project key
 * also counts (see `asksAboutTickets`).
 */
const TICKET_QUESTION = /\b(?:jira|tickets?|service\s+desk|slas?|repl(?:y|ies)|status|latest|updates?|progress|heard|answers?)\b/i;

/*
 * Change intent that the requester's own question must express before a model offer is
 * accepted. The model is untrusted and, with sharing on, reads customer-written ticket text,
 * so an offer on a question that asks for no change ("what did we decide about lunch?") is
 * dropped. A named project key also counts as a reply target (see `asksForChange`).
 */
/** raise: Jira or ticket wording, "raise", "escalate", "open a (...) request", "put ... into". */
const RAISE_INTENT = /\b(?:jira|tickets?|rais(?:e|es|ed|ing)|escalat(?:e|es|ed|ing)|open\s+(?:a|an)\s+(?:\w+\s+)?request|put\b.*\binto)\b/i;
/** close: "done", "close", "complete", "finish", "resolve" and their inflections. */
const CLOSE_INTENT = /\b(?:done|clos(?:e|es|ed|ing)|complet(?:e|es|ed|ing)|finish(?:es|ed|ing)?|resolv(?:e|es|ed|ing))\b/i;
/** reply, first part: a verb of sending a message ("reply", "tell", "send", "let ... know", "message", "answer"). */
const REPLY_VERB = /\b(?:repl(?:y|ies|ied|ying)|tell|send|let\b.*\bknow|message|answer)\b/i;
/** reply, second part: the service desk as recipient. */
const REPLY_TARGET = /\b(?:service\s+desk|jira|tickets?)\b/i;

/** Requester names shorter than this are not checked in reply bodies. */
const NAME_MIN_LENGTH = 2;

interface TicketCandidate {
  key: string;
  actionId: string;
}

/** A validated offer and the code-written question that asks the requester to confirm it. */
interface PreparedOffer {
  question: string;
  offer: PendingOffer;
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
 * When Jira support is provided, live data for linked tickets is added to the results (only
 * with sharing enabled), and a model-proposed offer is validated by code and turned into a
 * code-written confirmation question. This path never writes to Jira or the records.
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

    if (this.jira?.shareWithModel && asksAboutTickets(input.question, this.jira.tracker.projectKey)) {
      retrievalResults = [...retrievalResults, ...(await this.linkedTickets(this.jira, input, retrievalResults))];
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
    if (!prepared) {
      await this.send(input, text, true);
      return text;
    }

    // Only the code-written question is sent: the model's own lead-in can imply the change
    // already happened ("I'll send that ..."), which is wrong until the requester confirms.
    // No mentions: a quoted reply body may contain @names that must not ping members.
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
   * Live data for tickets linked from this conversation: keys of the configured project named
   * in the question, then keys shown on retrieved action results (`Jira: <KEY>`). Every key is
   * confirmed with an exact link query before use: result content includes member-written
   * descriptions, so a key read from it alone could name a ticket linked from another channel.
   * The content goes to the model only; it is never stored or logged.
   */
  private async linkedTickets(jira: AnswerQuestionJira, input: AnswerQuestionInput, results: RetrievalResult[]): Promise<RetrievalResult[]> {
    const candidates: TicketCandidate[] = [];
    const add = (candidate: TicketCandidate): void => {
      if (candidates.length < TICKETS_SHARED && !candidates.some((c) => c.key === candidate.key)) candidates.push(candidate);
    };

    try {
      for (const key of namedKeys(input.question, jira.tracker.projectKey)) {
        if (candidates.length >= TICKETS_SHARED) break;
        const action = await this.actionLinkingKey(jira.actions, key, input.conversationId);
        if (action) add({ key, actionId: action.id });
      }
      for (const result of results.filter((r) => r.type === "action").slice(0, ACTION_RESULTS_INSPECTED)) {
        if (candidates.length >= TICKETS_SHARED) break;
        const key = linkedKeyInContent(result.content);
        if (!key || !isKeyInProject(key, jira.tracker.projectKey) || candidates.some((c) => c.key === key)) continue;
        const action = await this.actionLinkingKey(jira.actions, key, input.conversationId);
        if (action) add({ key, actionId: action.id });
      }
    } catch (err) {
      this.logger?.warn("AnswerQuestion: linked ticket lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }

    const now = (jira.now ?? (() => new Date()))();
    const tickets = await Promise.all(candidates.map(async (candidate): Promise<RetrievalResult | null> => {
      try {
        const [snapshot, replies] = await Promise.all([
          jira.tracker.getIssue(candidate.key),
          jira.tracker.listCustomerReplies(candidate.key, REPLIES_SHARED),
        ]);
        if (!snapshot) return null;
        return {
          id: candidate.key,
          type: "jira_ticket",
          content: ticketContent(snapshot, candidate.actionId, replies),
          sourceChannel: input.channelId ?? "",
          sourceDate: now,
          confidence: 1,
          pathsMatched: ["jira"],
        };
      } catch (err) {
        this.logger?.warn("AnswerQuestion: ticket read failed", trackerErrorFields(err));
        return null;
      }
    }));
    return tickets.filter((t): t is RetrievalResult => t !== null);
  }

  /** The first non-deleted action in this conversation that links the key, or null. */
  private async actionLinkingKey(actions: ActionRepository, key: string, conversationId: QualifiedId): Promise<Action | null> {
    const link = toJiraLink(key);
    const found = await actions.query({ conversationId, linkedIdsHas: link, limit: LINK_QUERY_LIMIT });
    return found.find((a) => !a.deleted && sameQualifiedId(a.conversationId, conversationId) && a.linkedIds.includes(link)) ?? null;
  }

  /**
   * Validates a model-proposed offer. Returns the offer with its code-written question, or null
   * when the offer is dropped. Nothing is stored here: the caller stores the offer after sending.
   */
  private async prepareOffer(jira: AnswerQuestionJira, input: AnswerQuestionInput, command: OfferCommand): Promise<PreparedOffer | null> {
    if (!asksForChange(command.kind, input.question, jira.tracker.projectKey)) {
      this.logger?.warn("AnswerQuestion: offer dropped, the question asks for no change", { kind: command.kind });
      return null;
    }

    const requester = input.requester;
    let question: string | null = null;
    if (requester?.domain) {
      try {
        question = await this.offerQuestion(jira, command, input.conversationId, requester.name);
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
  private async offerQuestion(jira: AnswerQuestionJira, command: OfferCommand, conversationId: QualifiedId, requesterName: string | undefined): Promise<string | null> {
    const projectKey = jira.tracker.projectKey;
    if (command.kind === "reply") {
      if (!isKeyInProject(command.issueKey, projectKey)) return null;
      // Customer-facing replies never carry the requester's name, whatever the model wrote.
      if (requesterName && containsName(command.body, requesterName)) return null;
      if (!(await this.actionLinkingKey(jira.actions, command.issueKey, conversationId))) return null;
      const quoted = command.body.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
      return `Here is the reply for **${command.issueKey}**:\n${quoted}\n\nShall I send it (yes or no)?`;
    }

    const action = await jira.actions.findById(command.actionId);
    if (!action || action.deleted || !sameQualifiedId(action.conversationId, conversationId)) return null;
    const key = jiraKeyFromLinks(action.linkedIds);
    if (command.kind === "raise") {
      if (action.status === "done" || action.status === "cancelled" || key) return null;
      return `Shall I raise **${action.id}** "${action.description.replace(/\s+/g, " ").trim()}" in Jira (yes or no)?`;
    }
    if (action.status === "done" || action.status === "cancelled" || !key || !isKeyInProject(key, projectKey)) return null;
    return `Shall I mark **${action.id}** done and close **${key}** in Jira (yes or no)?`;
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
    case "raise":
      return RAISE_INTENT.test(question);
    case "close":
      return CLOSE_INTENT.test(question);
    case "reply":
      return REPLY_VERB.test(question) && (REPLY_TARGET.test(question) || namedKeys(question, projectKey).length > 0);
  }
}

/** Whole-word, case-insensitive match of a display name. Names under two characters never match. */
function containsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN_LENGTH) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * The ticket key of an action result, from its ` | `-separated `Jira: <KEY>` field. The last
 * such field wins because the real one follows the free-text description.
 */
function linkedKeyInContent(content: string): string | null {
  let key: string | null = null;
  for (const field of content.split(" | ")) {
    const match = /^Jira: (\S+)$/.exec(field.trim());
    if (match && JIRA_KEY_PATTERN.test(match[1]!)) key = match[1]!;
  }
  return key;
}

/** Compact ticket text for the model. Uses the English status label, never the tracker's status name. */
function ticketContent(snapshot: IssueSnapshot, actionId: string, replies: readonly IssueReply[]): string {
  const replyLines = replies.map((reply) => {
    const author = reply.fromThisBot ? "your team via Wire" : reply.author;
    const body = reply.body.replace(/\s+/g, " ").trim();
    const text = body.length <= SHARED_REPLY_MAX ? body : `${body.slice(0, SHARED_REPLY_MAX - 3).trimEnd()}...`;
    return `Reply from ${author} at ${reply.created.toISOString()}: ${text}`;
  });
  return [
    `${snapshot.key}: ${snapshot.summary}`,
    `Status: ${statusLabel(snapshot.statusCategory)}`,
    ...snapshot.slas.map(formatSla),
    `Linked action: ${actionId}`,
    ...(replyLines.length > 0 ? replyLines : ["No customer replies yet."]),
  ].join("\n");
}

