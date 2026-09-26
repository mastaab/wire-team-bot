import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { PART_DETAIL_MAX } from "../../../domain/entities/SupportRequest";
import type { PartDetails } from "../../../domain/entities/SupportRequest";
import type { OfferCommand, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { SupportTriagePort } from "../../ports/SupportTriagePort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { OFFER_TTL_MS, PART_DETAIL_FIELDS, formatMissingPartsQuestion, formatSupportQuestion, missingPartDetails } from "../../services/offers";

/** Contract: see PLAN.md §6 "Part orders completed in code, and no double capture". */
export interface CompletePartOrderInput {
  /** The requester's next message after a part order with missing essentials. */
  text: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** The part-order draft the router just took from the requester's pending offers. */
  pending: OfferCommand;
  replyToMessageId?: string;
}

/**
 * Fills a part order that still lacks essentials from the requester's next message, without
 * depending on the answer model returning a revised offer. The triage model only reports which
 * essentials this message states; code merges them into the draft (a value in this message
 * replaces an earlier one), then asks for what is still missing or shows the full offer. The
 * message text and the part values are never logged.
 */
export class CompletePartOrder {
  constructor(
    private readonly triage: SupportTriagePort,
    private readonly offers: PendingOfferStore,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** True when it replied (a question for what is still missing, or the complete offer) and stored the updated draft. */
  async execute(input: CompletePartOrderInput): Promise<boolean> {
    const pending = input.pending;
    // Any part-order draft: an incomplete one is filled, a complete one corrected ("actually three").
    if (pending.kind !== "support" || pending.requestKind !== "part") return false;

    let extracted: PartDetails;
    try {
      extracted = boundedDetails(await this.triage.extractPartDetails(input.text));
    } catch (err) {
      this.logger?.warn("CompletePartOrder: extractPartDetails failed", { err: errorName(err) });
      return false;
    }
    if (Object.keys(extracted).length === 0) return false;

    const command: Extract<OfferCommand, { kind: "support" }> = {
      kind: "support",
      requestKind: "part",
      summary: pending.summary,
      description: pending.description,
      part: { ...pending.part, ...extracted },
    };
    // A message that restates what the draft already holds is not an answer; leave it to normal routing.
    if (PART_DETAIL_FIELDS.every(({ key }) => (command.part?.[key] ?? "") === (pending.part?.[key] ?? ""))) return false;
    const missing = missingPartDetails(command);
    const question = missing.length > 0
      ? formatMissingPartsQuestion(missing)
      : formatSupportQuestion(command.summary, command.description, "part", command.part);
    try {
      await this.wireOutbound.sendPlainText(input.conversationId, question, { replyToMessageId: input.replyToMessageId });
    } catch (err) {
      this.logger?.warn("CompletePartOrder: sending the reply failed", { err: errorName(err) });
      return false;
    }
    const now = this.now();
    this.offers.put({
      command,
      conversationId: input.conversationId,
      requesterId: input.requesterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    });
    this.logger?.debug("CompletePartOrder: part order updated", { missing: missing.length });
    return true;
  }
}

/**
 * The essentials the model reported, each collapsed to one line. A value that is empty, not
 * text or longer than `PART_DETAIL_MAX` is left out, so it never replaces an earlier value.
 */
function boundedDetails(details: PartDetails | null | undefined): PartDetails {
  const bounded: PartDetails = {};
  if (!details || typeof details !== "object") return bounded;
  for (const { key } of PART_DETAIL_FIELDS) {
    const raw: unknown = details[key];
    const value = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (value && value.length <= PART_DETAIL_MAX) bounded[key] = value;
  }
  return bounded;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
