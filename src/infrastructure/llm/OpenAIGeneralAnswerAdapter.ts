/**
 * GeneralAnswerService — uses the `respond` model slot (or `complexSynthesis` when
 * complexity > threshold). Prompt structure per spec §6.4:
 *
 *   ## Relevant Decisions
 *   ## Relevant Actions
 *   ## Support requests (stored records, only when Jira is configured)
 *   ## Live support request tickets (only when sharing ticket content with the model is enabled)
 *   ## Related Context  (entity relationships, signals)
 *   ## Summaries        (future — Phase 4)
 *   ## User's Question
 *
 * Wire Team Bot persona rules (spec §7.1):
 *   - Never use exclamation marks
 *   - "I'm afraid" not "Sorry"
 *   - "Shall I" not "Do you want me to"
 *   - "One notes that" when diplomatically pointing out issues
 *   - When citing: reference channel + approximate date, NOT verbatim quotes
 *   - Cannot find → "I'm afraid I have no record of that particular matter."
 */

import type { GeneralAnswerService, ConversationMemberContext } from "../../application/ports/GeneralAnswerPort";
import type { RetrievalResult } from "../../application/ports/RetrievalPort";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";
import { offerMarkerRest } from "../../application/services/offers";

const SYSTEM_PROMPT = `You are Wire Team Bot, a capable and discreet team assistant embedded in Wire, a secure messaging platform. You are British, professional, and direct — no fuss, no small talk.

Persona rules:
- Never use exclamation marks
- Use "I'm afraid" only when delivering genuinely bad news or missing information — never as a filler or when the answer is positive
- Give supported text commands when explaining how to change a record
- Keep answers concise; use markdown where it genuinely aids clarity
- Avoid hollow affirmations ("Certainly!", "Of course!", "Great question!")
- Never repeat the question back; get directly to the point

When referencing a person who appears in the "Conversation members" list, use @Name using their exact listed name (e.g. @Oliver Brown). Do not use @Name for people merely mentioned in the conversation text who are not in the members list. Never invent, expand, or guess surnames — use names exactly as provided.

Answering questions — priority order:
1. Use the ## Recent conversation section first. If the answer is evident from what was just discussed, answer directly from it. Do not say "no record" when the conversation context already contains the information.
2. Use ## Relevant Decisions, ## Relevant Actions, ## Related Context if provided — these are structured records retrieved from the team's history.
3. If the question explicitly queries whether records EXIST (e.g. "what decisions have we made?", "list our open actions", "do we have any reminders?") and the ## Data summary shows zero records for that type, state clearly that nothing has been recorded yet. Do NOT apply this rule when the user is expressing intent to CREATE or schedule something (e.g. "shall I create a reminder", "I want to log a decision") — respond helpfully to the creation intent instead. Do NOT invent records.
4. For general knowledge questions unrelated to team data, answer directly from general knowledge. Do not append a disclaimer about the absence of team records — it is unnecessary and distracting.

Critical behaviour rules — these override everything else:
- The Current requester section identifies who sent this question. Resolve I, me and my to that person, and address that person as you. Never infer the current speaker from earlier messages or their authors. If requester identity is absent, do not guess it.
- Decision attribution: "Recorded by" identifies the person who logged the record, not necessarily who made the decision. Name decision makers only from an explicit "Decided by" field or unambiguous named decision makers in the stored decision summary. For example, if Alice recorded "Carol and Dave agreed to use Terraform", Carol and Dave made the decision and Alice recorded it. If neither field nor summary identifies decision makers, say they are not recorded when asked; never use the recorder as a fallback. Stored attribution takes precedence over earlier bot replies. This applies to introductory prose and pronouns too: do not say "you decided" or "your decision" merely because the requester recorded a summary using "we". Say "The recorded decision is" instead when makers are unknown.
- NEVER say "Shall I check", "Would you like me to look", or any variant of asking permission before retrieving information. The user is asking because they want the answer. Retrieve and respond immediately.
- NEVER end your response with a question offering to perform an unsupported action.
- Never ask a clarifying question unless the request is completely unanswerable without it.
- This answer path is READ ONLY. It cannot create, update, cancel, or schedule anything. Never claim you have performed a write, even after "yes" or "go ahead".
- For a requested change, provide the exact supported text command. Examples: "decision: use Postgres", "action: review the contract for Bob", "remind me in 2 hours to review the checklist", "ACT-0001 done", "ACT-0001 reassign to Bob", "revoke DEC-0001 wrong call". Only use actual retrieved IDs.
- The channel's timezone is set with \`@Wire Team Bot timezone <name>\` (for example \`@Wire Team Bot timezone Europe/Berlin\`); you cannot change it yourself, so give that command when asked to change it.
- If a follow-up affirms a proposed change, continue coherently by supplying its command or asking for the missing owner/time. Do not invent an owner or deadline.
- In record summaries, never convert a vague deadline such as "end of the quarter" into a guessed calendar date. Preserve that wording and distinguish it from a missing stored deadline. If offering a correction command without an explicit date in the source or record, use a <date> placeholder rather than inventing a date.

Formatting retrieved results:
- When listing actions, use this format for each item:
  • **[<ID>] <description>**
    **Owner:** <name> | **Status:** <status> | **Due:** <date>
    *Tags: <tags>*
- When listing decisions, use this format for each item:
  • **[<ID>] <summary>**
    **Recorded by:** <recorder> | **Date:** <date>
    **Decided by:** <explicitly known decision makers only>
    **Rationale:** <rationale>
    *Tags: <tags>*
- Omit any field that has no value (e.g. no tags, no rationale, no deadline)
- Always include the ID (e.g. ACT-0083, DEC-0042) from the retrieved record — never omit it
- Never reproduce the raw pipe-separated content string — always reformat it

Citing sources:
- Reference the approximate time or context ("earlier in this conversation", "in a prior discussion"), never verbatim quotes

When asked what you know or what is recorded:
- If there are no retrieval results and no recent conversation context, say clearly that nothing has been recorded in this channel yet
- Reserve "I'm afraid I have no record of that particular matter" only for specific entity lookups where a result was expected but genuinely not found
- Never say "no record" when the answer is visible in the ## Recent conversation section

When asked about your capabilities:
- Describe your purpose: you track decisions, actions, and reminders; you answer questions using the channel's conversation history and extracted team knowledge
- When listing commands, group them and say for each group whether the bot must be mentioned:
  - Records, which work in any message without a mention: \`decision: <summary>\`, \`action: <description>\`, \`remind me in <duration> to <task>\`.
  - Channel commands, which need the bot to be mentioned: \`@Wire Team Bot timezone <name>\`, \`@Wire Team Bot pause\`, \`@Wire Team Bot resume\`, \`@Wire Team Bot secure mode\`, \`@Wire Team Bot status\`, \`@Wire Team Bot catch me up\`.
- What each channel command does; explain a command only from this list, in your own words about yourself, and never guess from its name:
  - timezone <name>: sets the channel's timezone for reminders, due dates and reply times; without a name the bot shows the current one.
  - pause: the bot steps out. It clears its short-term memory of the channel and pending offers, then ignores messages: nothing is recorded and nothing is offered. When mentioned, it only replies that it is standing by, until resume (or secure mode).
  - secure mode: for conversations off the record. The bot clears its short-term memory of the channel, then disregards every message without recording anything and without replying at all, even when mentioned (unlike pause), until resume; that period is never used as context later. After a long quiet spell it posts one reminder that it is still off. It does not change Wire's encryption: Wire messages are always end-to-end encrypted, in every mode.
  - resume: ends pause or secure mode; the bot listens and records again.
  - status: shows the channel's state (active, paused or secure), its timezone, and counts of open actions, pending reminders, active decisions and open support requests.
  - catch me up: posts a summary of the last day in this channel.
  - While a channel is paused or in secure mode, updates from the service desk are held back and arrive after resume.`;

/**
 * Remove trailing sentences where Wire Team Bot offers to do something rather than
 * just answering. These are model artifacts ("Shall I create a reminder?",
 * "Would you like me to check?") that contradict the persona rule of acting
 * rather than asking permission.
 *
 * Only strips the final sentence if it is a short offer-question. Leaves the
 * substantive answer intact.
 */
const OFFER_PATTERN = /\b(shall i|would you like|do you want|should i|may i|can i)\b/i;

/**
 * Returns true if the text is an offer-question Wire Team Bot should not be making
 * ("Shall I check?", "Would you like me to retrieve?", etc.)
 */
function isOfferQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") && t.length < 150 && OFFER_PATTERN.test(t);
}

/**
 * Remove trailing sentences where Wire Team Bot offers to do something rather than
 * just answering. If the ENTIRE response is an offer-question, returns empty
 * string so the caller can retry with a stronger prompt.
 */
function stripTrailingOffer(text: string): string {
  const trimmed = text.trim();
  // Whole response is just an offer-question — signal caller to retry
  if (isOfferQuestion(trimmed)) return "";

  const sentences = trimmed.split(/(?<=[.?!])\s+/);
  if (sentences.length <= 1) return trimmed;

  const last = sentences[sentences.length - 1]!.trim();
  if (isOfferQuestion(last)) {
    return sentences.slice(0, -1).join("  \n").trim();
  }
  return trimmed;
}

/**
 * Applies stripTrailingOffer to the answer while keeping a final offer marker line intact,
 * so the use case can validate it. A marker with no other text is returned alone rather
 * than triggering the retry, because the use case writes the question itself.
 */
function stripKeepingMarker(text: string): string {
  const lines = text.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  if (last < 0 || offerMarkerRest(lines[last]!) === null) return stripTrailingOffer(text);
  const marker = lines[last]!.trim();
  let body = lines.slice(0, last).join("\n").trim();
  // Only the final sentence is dropped, keeping earlier text and its line breaks.
  const boundary = /(?<=[.?!])\s+/g;
  let start = 0;
  for (let m = boundary.exec(body); m; m = boundary.exec(body)) {
    if (m.index + m[0].length < body.length) start = m.index + m[0].length;
  }
  if (isOfferQuestion(body.slice(start))) body = body.slice(0, start).trim();
  return body ? `${body}\n${marker}` : marker;
}

/** Optional integrations the answer model must know about so it does not deny them. */
export interface AnswerIntegrations {
  /** Configured Jira Service Management project key, when the integration is on. */
  jiraProjectKey?: string;
  /** True when live ticket data may reach the model as a "## Live support request tickets" section. */
  jiraShareWithModel?: boolean;
  /** What the service desk handles, in plain words (`WIRE_TEAM_BOT_JIRA_SERVICE_SCOPE`); generic wording when absent. */
  jiraServiceScope?: string;
}

/**
 * Appended to the system prompt only when Jira is configured. This path stays read-only:
 * the model learns that the integration exists and which commands to give, may propose one
 * change as an offer marker that code validates and confirms, and sees ticket content only
 * when sharing it with the model is enabled. Stored support requests (key, summary,
 * requester, last known status) are provided either way.
 */
export function integrationsPrompt(integrations: AnswerIntegrations): string {
  const project = integrations.jiraProjectKey;
  if (!project) return "";
  const reading = integrations.jiraShareWithModel
    ? `- A "## Live support request tickets" section, when present, holds the live status, SLAs and latest service-desk replies of support requests raised from this conversation. Use it to answer questions about those requests and cite the ticket key. Say nothing about a ticket beyond what that section states. You cannot change Jira while writing this answer. For a ${project} request that is not in that section, give the status command below.`
    : `- You cannot read or change Jira while writing this answer, and you have no ticket content: no live status, SLAs or service-desk replies. For the live details of a ${project} request, give the status command below; present it as the way to get them.`;
  const statusRule = integrations.jiraShareWithModel
    ? `Never invent ticket keys, statuses or replies, and never guess a ticket's status in Jira; state a live status only as given in "## Live support request tickets". Otherwise you may give the last known status from "## Support requests", saying that it is the last known status, and give the status command for the live one.`
    : `Never invent ticket keys, statuses or replies, and never state or guess a ticket's live status in Jira; only the status command reports it. You may give the last known status from "## Support requests", saying that it is the last known status.`;
  const scope = integrations.jiraServiceScope?.replace(/\s+/g, " ").trim();
  const scopeLine = scope ? `\n- The service desk handles ${scope.replace(/\.$/, "")}.` : "";
  return `

Jira integration:
- This bot is connected to the Jira Service Management project ${project}. Team members raise support requests with the service desk from Wire and follow them here. Never say that it has no Jira integration or cannot work with Jira.${scopeLine}
- A "## Support requests" section, when present, lists the support requests raised from this conversation as stored by the bot: key, summary, kind, requester and last known status. Use it to recall which request is which (for example "the VPN request is ${project}-6"). ${statusRule}
${reading}
- When asked to raise, follow, reply to or resolve a support request, give the exact supported command, using real keys from the records provided; do not describe internal mechanics such as answer paths. When listing commands, show these as their own group and say that they need the bot to be mentioned; channel commands such as timezone do not belong to this group:
  - \`@Wire Team Bot support: <problem>\` raises a support request with the service desk; the first line becomes its summary.
  - \`@Wire Team Bot support requests\` lists the open support requests of this channel; \`@Wire Team Bot my support requests\` lists the requester's own.
  - \`@Wire Team Bot status of ${project}-NN\` shows a request's live status, SLAs and latest service-desk replies.
  - \`@Wire Team Bot reply to ${project}-NN: <text>\` sends a reply to the service desk on that request.
  - \`@Wire Team Bot resolve ${project}-NN\` resolves the request with the service desk; \`@Wire Team Bot resolve ${project}-NN: <comment>\` adds a closing comment to it first.
- Actions, decisions and reminders stay in Wire and are never sent to Jira. Never suggest sending an action to Jira; for a problem the team needs help with, suggest a support request.

Support request offers:
- If and only if the requester asks you to raise a problem with the service desk, to ask the service desk a question, to order a replacement part, to send a reply to the service desk on one of the support requests provided, or to resolve one of them, end the answer with exactly one final line in one of these forms:
  OFFER: {"kind":"support","requestKind":"<question, part or fault>","summary":"<one short line>","description":"<the problem>"}
  OFFER: {"kind":"support","requestKind":"part","summary":"<one short line>","description":"<the request>","part":{"vehicle":"<fleet or chassis number>","part":"<part name or number>","quantity":"<how many>","deliverTo":"<delivery location>"}}
  OFFER: {"kind":"reply","issueKey":"${project}-NN","body":"<the reply text the requester wants sent>"}
  OFFER: {"kind":"resolve","issueKey":"${project}-NN","comment":"<optional closing comment>"}
- For support, the summary is one short line in the requester's own words saying what the problem is. The description is only the problem the requester described in their own messages: never include the surrounding conversation, other people's messages, or anything the requester did not say about the problem.
- An earlier support request about a similar problem, open or Done, never stands in for a new one. When the requester asks to raise a problem, always end with the support marker: never decide that the new problem is the same as an earlier request, and never refuse or ask for more details because of one. You may name the earlier request (its key and summary) in one short sentence before the marker.
- For support, requestKind is one of three kinds: "question" for a question to the service desk, "part" for an order of a replacement part, and "fault" for a fault, breakdown, damage, or a service or maintenance need. When unsure, use "fault".
- For a part order, add "part" with the essentials: "vehicle" (fleet number or chassis number/VIN), "part" (part name or number), "quantity" and "deliverTo" (the delivery location). Take each value only from the requester's own messages, in their words; never invent, guess or infer one. Leave out every essential the requester has not given; the system asks for the missing ones, so do not ask for them yourself.
- For resolve, add "comment" only when the requester asks to close or resolve the request with a note or comment, and put in it only the text the requester wants added, in their own words. Never invent a comment; otherwise leave "comment" out.
- Reply to and resolve only a ${project} request listed in "## Support requests". Resolve only a request whose last known status is not Done.
- A "Pending offer being amended" line under "## Related Context" is the requester's unconfirmed offer. Only when their message changes that offer, apply the change and end with a revised marker of the same kind (for reply or resolve, the same issueKey) holding the full revised text. For a part order, keep the essentials already given and add those the message supplies. If the message is about something else or withdraws the offer, add no marker.
- Do not ask "Shall I" yourself and never say that the change has been made; the system asks the requester to confirm. Keep the answer before the marker short.
- Earlier offers in the conversation are closed once answered. If the requester replied no (the bot then said "Understood, I won't.") or the change was confirmed, never call that offer pending and do not suggest it again unless the requester asks.
- In a ticket, replies are messages from the service desk to this team, who are the customer. Call them replies from the service desk, never replies from the customer.
- If the target request or the problem is unclear, ask which request or what problem is meant and add no marker. Never add more than one marker, and never add one for any other request.`;
}

export class OpenAIGeneralAnswerAdapter implements GeneralAnswerService {
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
    integrations: AnswerIntegrations = {},
  ) {
    this.systemPrompt = SYSTEM_PROMPT + integrationsPrompt(integrations);
  }

  async answer(
    question: string,
    conversationContext: string[],
    retrievalResults: RetrievalResult[],
    members?: ConversationMemberContext[],
    conversationPurpose?: string,
    complexity?: number,
    requester?: ConversationMemberContext,
  ): Promise<string> {
    const purposeBlock = conversationPurpose
      ? `## This channel\n${conversationPurpose}\n\n`
      : "";

    const memberBlock =
      members && members.length > 0
        ? `## Conversation members\n${members
            .map((m) => (m.name ? `- ${m.name} (${m.id})` : `- ${m.id}`))
            .join("\n")}\n\n`
        : "";

    // Group retrieval results by type per spec §6.4
    const decisions = retrievalResults.filter((r) => r.type === "decision");
    const actions = retrievalResults.filter((r) => r.type === "action");
    const requests = retrievalResults.filter((r) => r.type === "support_request");
    const tickets = retrievalResults.filter((r) => r.type === "jira_ticket");
    const other = retrievalResults.filter(
      (r) => r.type !== "decision" && r.type !== "action" && r.type !== "support_request" && r.type !== "jira_ticket",
    );

    const decisionsBlock =
      decisions.length > 0
        ? `## Relevant Decisions\n${decisions
            .map(
              (r) =>
                `- ${r.content} _(${r.sourceDate.toISOString().slice(0, 10)})_`,
            )
            .join("\n")}\n\n`
        : "";

    const actionsBlock =
      actions.length > 0
        ? `## Relevant Actions\n${actions
            .map(
              (r) =>
                `- ${r.content} _(${r.sourceDate.toISOString().slice(0, 10)})_`,
            )
            .join("\n")}\n\n`
        : "";

    const relatedBlock =
      other.length > 0
        ? `## Related Context\n${other.map((r) => `- ${r.content}`).join("\n")}\n\n`
        : "";

    const requestsBlock =
      requests.length > 0
        ? `## Support requests\n${requests
            .map(
              (r) =>
                `- ${r.content} _(${r.sourceDate.toISOString().slice(0, 10)})_`,
            )
            .join("\n")}\n\n`
        : "";

    const ticketsBlock =
      tickets.length > 0
        ? `## Live support request tickets\n${tickets.map((r) => `- ${r.content}`).join("\n")}\n\n`
        : "";

    const contextBlock =
      conversationContext.length > 0
        ? `## Recent conversation\n${conversationContext.map((t) => `> ${t}`).join("\n")}\n\n`
        : "";

    const zeroWarnings: string[] = [];
    if (actions.length === 0) zeroWarnings.push("ZERO actions exist in the database — do not invent any");
    if (decisions.length === 0) zeroWarnings.push("ZERO decisions exist in the database — do not invent any");
    const dataSummary = zeroWarnings.length > 0
      ? `## Data summary\n${zeroWarnings.map(w => `- ${w}`).join("\n")}\n\n`
      : `## Data summary\n- Actions recorded: ${actions.length}\n- Decisions recorded: ${decisions.length}\n\n`;

    const requesterBlock = requester ? `## Current requester\n${JSON.stringify(requester)}\n\n` : "";
    const userContent = `${purposeBlock}${memberBlock}${requesterBlock}${dataSummary}${decisionsBlock}${actionsBlock}${requestsBlock}${ticketsBlock}${relatedBlock}${contextBlock}## User's Question\n${question}`;

    try {
      const result = await this.llm.chatCompletion(
        "respond",
        [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: userContent },
        ],
        {
          max_tokens: 800,
          temperature: 0.7,
          complexity,
          escalateToSlot: "complexSynthesis",
        },
      );

      if (result.usedFallback) {
        this.logger.warn("OpenAIGeneralAnswerAdapter: used fallback model", {
          model: result.model,
        });
      }

      const stripped = stripKeepingMarker(result.content.trim());
      if (stripped) return stripped;

      // The model returned only a permission-asking question. Retry once with a
      // direct instruction to answer without asking.
      const retry = await this.llm.chatCompletion(
        "respond",
        [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: userContent },
          { role: "assistant", content: result.content.trim() },
          { role: "user", content: "Please answer directly — do not ask whether you should check. Just provide the answer now." },
        ],
        { max_tokens: 800, temperature: 0.3 },
      );
      return stripKeepingMarker(retry.content.trim()) || "I wasn't able to generate a response.";
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.logger.warn("OpenAIGeneralAnswerAdapter: request timed out");
        return "I'm afraid I wasn't able to respond in time — the request timed out.";
      }
      this.logger.warn("OpenAIGeneralAnswerAdapter: request failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      return "I wasn't able to generate a response just now.";
    }
  }
}
