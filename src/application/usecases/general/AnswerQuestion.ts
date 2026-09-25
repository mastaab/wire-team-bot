import type { GeneralAnswerService, ConversationMemberContext } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort, OutboundMention } from "../../ports/WireOutboundPort";
import type { QueryAnalysisPort, MemberContext } from "../../ports/QueryAnalysisPort";
import type { RetrievalPort, RetrievalResult, RetrievalScope } from "../../ports/RetrievalPort";
import type { ChannelContext } from "../../ports/ClassifierPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import { isKeyInProject, jiraKeyFromLinks, toJiraLink } from "../../../domain/ids/jiraLink";
import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { Logger } from "../../ports/Logger";
import { trackerErrorFields } from "../../ports/IssueTrackerPort";
import type { IssueReply, IssueSnapshot, IssueTrackerPort } from "../../ports/IssueTrackerPort";
import { OFFER_TTL_MS, parseOfferMarker } from "../../services/offers";
import type { OfferCommand, PendingOfferStore } from "../../services/offers";
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
/** A model-written offer question that the code-written one replaces. */
const MODEL_OFFER_QUESTION = /\b(shall i|would you like|do you want|should i)\b/i;

interface TicketCandidate {
  key: string;
  actionId: string;
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

    if (this.jira?.shareWithModel) {
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

    const answer = this.jira ? await this.withOffer(this.jira, input, modelAnswer) : modelAnswer;

    const mentions = extractMentions(answer, input.members ?? []);

    await this.wireOutbound.sendPlainText(input.conversationId, answer, {
      replyToMessageId: input.replyToMessageId,
      mentions: mentions.length > 0 ? mentions : undefined,
    });

    return answer;
  }

  /**
   * Live data for tickets linked from this conversation: keys of the configured project named
   * in the question, then keys linked from retrieved actions. The content goes to the model
   * only; it is never stored or logged.
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
        const action = await jira.actions.findById(result.id);
        if (!action || action.deleted || !sameQualifiedId(action.conversationId, input.conversationId)) continue;
        const key = jiraKeyFromLinks(action.linkedIds);
        if (key && isKeyInProject(key, jira.tracker.projectKey)) add({ key, actionId: action.id });
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
   * Strips the model's offer marker and, when code validates the proposed command, stores the
   * offer and appends a code-written confirmation question. The raw marker is never sent.
   */
  private async withOffer(jira: AnswerQuestionJira, input: AnswerQuestionInput, modelAnswer: string): Promise<string> {
    const parsed = parseOfferMarker(modelAnswer);
    const text = parsed.text;
    const command = parsed.command;
    if (!command) return text || FALLBACK_ANSWER;

    const requester = input.requester;
    let question: string | null = null;
    if (requester?.domain) {
      try {
        question = await this.offerQuestion(jira, command, input.conversationId);
      } catch (err) {
        this.logger?.warn("AnswerQuestion: offer validation failed", { kind: command.kind, err: err instanceof Error ? err.name : "UnknownError" });
        return text || FALLBACK_ANSWER;
      }
    }
    if (!question || !requester?.domain) {
      this.logger?.warn("AnswerQuestion: offer dropped", { kind: command.kind });
      return text || FALLBACK_ANSWER;
    }

    const now = (jira.now ?? (() => new Date()))();
    jira.offers.put({
      command,
      conversationId: input.conversationId,
      requesterId: { id: requester.id, domain: requester.domain },
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    });
    const body = stripModelOfferQuestion(text);
    return body ? `${body}\n\n${question}` : question;
  }

  /** Validates the proposed command against the records; returns the question, or null when invalid. */
  private async offerQuestion(jira: AnswerQuestionJira, command: OfferCommand, conversationId: QualifiedId): Promise<string | null> {
    const projectKey = jira.tracker.projectKey;
    if (command.kind === "reply") {
      if (!isKeyInProject(command.issueKey, projectKey)) return null;
      if (!(await this.actionLinkingKey(jira.actions, command.issueKey, conversationId))) return null;
      const quoted = command.body.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
      return `Shall I send this reply to **${command.issueKey}** in Jira?\n${quoted}\n\nReply yes or no.`;
    }

    const action = await jira.actions.findById(command.actionId);
    if (!action || action.deleted || !sameQualifiedId(action.conversationId, conversationId)) return null;
    const key = jiraKeyFromLinks(action.linkedIds);
    if (command.kind === "raise") {
      if (action.status === "done" || action.status === "cancelled" || key) return null;
      return `Shall I raise **${action.id}** "${action.description.replace(/\s+/g, " ").trim()}" in Jira? Reply yes or no.`;
    }
    if (action.status === "done" || !key || !isKeyInProject(key, projectKey)) return null;
    return `Shall I mark **${action.id}** done and close **${key}** in Jira? Reply yes or no.`;
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

/** Removes a final model-written offer question, e.g. "Shall I raise it in Jira?". */
function stripModelOfferQuestion(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.endsWith("?")) return trimmed;
  const head = trimmed.slice(0, -1);
  const boundary = /[.?!]\s+|\n/g;
  let start = 0;
  for (let m = boundary.exec(head); m; m = boundary.exec(head)) start = m.index + m[0].length;
  return MODEL_OFFER_QUESTION.test(trimmed.slice(start)) ? trimmed.slice(0, start).trim() : trimmed;
}
