/**
 * Tier 1 Classifier — uses the `classify` model slot.
 * Returns categories[], is_high_signal, and entity hints for Tier 2.
 * Does NOT return a single intent; that is the old ConversationIntelligence approach.
 */

import type { ClassifierPort, ClassifyResult, ChannelContext, MessageCategory } from "../../application/ports/ClassifierPort";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are the Tier 1 classifier for Wire Team Bot, a discreet British team assistant.

Classify the message into one or more of these categories:
- decision: a conclusion or choice has been made or recorded
- action: a commitment or task has been assigned or accepted
- question: an open question is posed to the team
- blocker: progress is blocked by an impediment
- update: a status update on ongoing work
- discussion: general team deliberation, not yet resolved
- reference: a link, resource, or reference to external material
- routine: greetings, acknowledgements, chit-chat, bot commands — no team knowledge

Named entities: extract any proper nouns that are project names, people, services, tools, or teams.

High signal: set is_high_signal=true when categories include decision, action, blocker, or update. Completion announcements such as 'I have sent the NDA' are updates and must reach extraction to close existing work.
Low signal (discussion-only, question, routine): is_high_signal=false.

Return ONLY valid JSON — no markdown, no explanation:
{"categories":["<cat1>","<cat2>"],"confidence":<0.0-1.0>,"entities":["<name1>"],"is_high_signal":<true|false>}`;

const VALID_CATEGORIES: MessageCategory[] = [
  "decision", "action", "question", "blocker",
  "update", "discussion", "reference", "routine",
];

/** Offered only with passive service-desk help, so classification is unchanged otherwise. */
const SERVICE_DESK_CATEGORIES: MessageCategory[] = ["service_request", "request_status"];

const ROUTINE_LINE = "- routine: greetings, acknowledgements, chit-chat, bot commands — no team knowledge\n";
const LOW_SIGNAL_LINE = "Low signal (discussion-only, question, routine): is_high_signal=false.\n";

const GENERIC_SERVICE_REQUEST_LINE =
  "- service_request: someone describes a problem, fault or need that a service desk could handle, such as something broken, an error, or access they need, or adds information to a problem already reported (a new detail, a change, it happened again, it now affects more places)\n";

/** The `service_request` line when the operator described what the desk handles. */
function scopedServiceRequestLine(scope: string): string {
  return `- service_request: someone brings the service desk something it handles (${scope}): a question to the desk, a fault or need, a replacement part order or a scheduled service all count; or adds information to a problem already reported (a new detail, a change, it happened again, it now affects more places)\n`;
}

function serviceDeskPrompt(serviceRequestLine: string): string {
  return SYSTEM_PROMPT
    // A replacer function, so "$" in the operator's scope text is not read as a replacement pattern.
    .replace(ROUTINE_LINE, () => ROUTINE_LINE +
      serviceRequestLine +
      "- request_status: someone asks about the state of a problem or service request they or others reported\n")
    .replace(LOW_SIGNAL_LINE, LOW_SIGNAL_LINE +
      "service_request and request_status never make a message high signal on their own. They come in addition to every other category that applies: a problem that blocks work is also a blocker, and a commitment to fix it is also an action.\n");
}

const HIGH_SIGNAL_CATEGORIES: MessageCategory[] = ["decision", "action", "blocker", "update"];

export interface ClassifierOptions {
  /** Adds `service_request` and `request_status` to the prompt and the accepted list (passive service-desk help). */
  serviceDeskCategories?: boolean;
  /** What the service desk handles (`WIRE_TEAM_BOT_JIRA_SERVICE_SCOPE`); used for the `service_request` line only with `serviceDeskCategories`. */
  serviceScope?: string;
}

const FALLBACK: ClassifyResult = {
  categories: ["discussion"],
  confidence: 0,
  entities: [],
  is_high_signal: false,
};

export class OpenAIClassifierAdapter implements ClassifierPort {
  private readonly systemPrompt: string;
  private readonly validCategories: readonly MessageCategory[];
  private readonly serviceDesk: boolean;

  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
    options: ClassifierOptions = {},
  ) {
    this.serviceDesk = options.serviceDeskCategories === true;
    const scope = options.serviceScope?.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
    this.systemPrompt = !this.serviceDesk ? SYSTEM_PROMPT
      : serviceDeskPrompt(scope ? scopedServiceRequestLine(scope) : GENERIC_SERVICE_REQUEST_LINE);
    this.validCategories = this.serviceDesk ? [...VALID_CATEGORIES, ...SERVICE_DESK_CATEGORIES] : VALID_CATEGORIES;
  }

  async classify(text: string, context: ChannelContext, window: string[]): Promise<ClassifyResult> {
    const purposeLine = context.purpose ? `Channel purpose: ${context.purpose}\n` : "";
    const contextTypeLine = context.contextType ? `Channel type: ${context.contextType}\n` : "";
    const windowSample = window.slice(-5).join("\n") || "(none)";

    const userContent = [
      purposeLine + contextTypeLine,
      "Recent conversation context:",
      windowSample,
      "",
      `Message to classify: "${text}"`,
    ].join("\n");

    let result: ChatResult;
    try {
      result = await this.llm.chatCompletion("classify", [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: userContent },
      ], { max_tokens: 150, temperature: 0 });
    } catch (err) {
      this.logger.warn("Classifier LLM call failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      return FALLBACK;
    }

    let parsed: {
      categories?: unknown;
      confidence?: unknown;
      entities?: unknown;
      is_high_signal?: unknown;
    };

    try {
      parsed = JSON.parse(result.content.replace(/^```json\s*|\s*```$/g, "").trim()) as typeof parsed;
    } catch {
      this.logger.warn("Classifier — failed to parse LLM response", { responseLength: result.content.length });
      return FALLBACK;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return FALLBACK;
    const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
    const categories = rawCategories.filter(
      (c): c is MessageCategory => typeof c === "string" && this.validCategories.includes(c as MessageCategory),
    );
    if (categories.length === 0) categories.push("discussion");

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter((e): e is string => typeof e === "string")
      : [];

    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
    const modelHighSignal =
      categories.includes("update") && confidence >= 0.6 ? true :
      typeof parsed.is_high_signal === "boolean"
        ? parsed.is_high_signal
        : categories.some((c) => c === "decision" || c === "action" || c === "blocker");
    // A service-desk category alone never reaches extraction.
    const serviceDeskOnly = this.serviceDesk
      && categories.some((c) => SERVICE_DESK_CATEGORIES.includes(c))
      && !categories.some((c) => HIGH_SIGNAL_CATEGORIES.includes(c));
    const is_high_signal = serviceDeskOnly ? false : modelHighSignal;

    const classify: ClassifyResult = { categories, confidence, entities, is_high_signal };

    this.logger.debug("Classifier result", {
      channelId: context.channelId,
      categories,
      is_high_signal,
      confidence,
      usedFallback: result.usedFallback,
    });

    return classify;
  }
}

type ChatResult = Awaited<ReturnType<LLMClientFactory["chatCompletion"]>>;
