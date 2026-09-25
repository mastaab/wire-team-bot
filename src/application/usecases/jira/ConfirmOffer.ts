import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { PendingOfferStore } from "../../services/offers";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { PushActionToJira } from "./PushActionToJira";
import type { ReplyToServiceDesk } from "./ReplyToServiceDesk";
import type { UpdateActionStatus } from "../actions/UpdateActionStatus";

export type Confirmation = "yes" | "no";

export interface ConfirmOfferHandlers {
  pushActionToJira: PushActionToJira;
  updateActionStatus: UpdateActionStatus;
  replyToServiceDesk: ReplyToServiceDesk;
}

export interface ConfirmOfferInput {
  text: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  timezone: string;
  replyToMessageId?: string;
}

const YES: ReadonlySet<string> = new Set([
  "yes", "y", "yes please", "yep", "yeah", "sure", "ok", "okay",
  "go ahead", "do it", "please do", "confirm", "confirmed",
]);
const NO: ReadonlySet<string> = new Set(["no", "n", "nope", "no thanks", "cancel", "don't", "do not", "stop"]);

/**
 * Classifies a short confirmation reply. Only the listed forms count, optionally with
 * trailing punctuation, backticks or a trailing "thanks", "thank you" or "please"; anything
 * longer ("yes but change the owner first") is not a confirmation.
 */
export function classifyConfirmation(text: string): Confirmation | null {
  const normalised = normalise(text);
  if (!normalised) return null;
  const candidates = [normalised, normalise(stripCourtesy(normalised))];
  if (candidates.some(c => YES.has(c))) return "yes";
  if (candidates.some(c => NO.has(c))) return "no";
  return null;
}

function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/`/g, "")
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCourtesy(text: string): string {
  return text.replace(/[\s,]+(thanks|thank you|please)$/, "");
}

/**
 * Runs a pending offer when its requester confirms it. The offer is consumed once, and the
 * dispatched use case re-validates scope and state at that moment.
 */
export class ConfirmOffer {
  constructor(
    private readonly offers: PendingOfferStore,
    private readonly handlers: ConfirmOfferHandlers,
    private readonly wireOutbound: WireOutboundPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** True when the message confirmed or declined this requester's pending offer. */
  async execute(input: ConfirmOfferInput): Promise<boolean> {
    const answer = classifyConfirmation(input.text);
    if (!answer) return false;

    const now = this.now();
    if (!this.offers.has(input.conversationId, input.requesterId, now)) return false;
    const offer = this.offers.take(input.conversationId, input.requesterId, now);
    if (!offer) return false;

    const { conversationId, requesterId: actorId, replyToMessageId } = input;
    if (answer === "no") {
      await this.wireOutbound.sendPlainText(conversationId, "Understood, I won't.", { replyToMessageId });
      return true;
    }

    const command = offer.command;
    switch (command.kind) {
      case "raise":
        await this.handlers.pushActionToJira.execute({
          actionId: command.actionId, conversationId, actorId, timezone: input.timezone, replyToMessageId,
        });
        break;
      case "close":
        await this.handlers.updateActionStatus.execute({
          actionId: command.actionId, newStatus: "done", conversationId, actorId, replyToMessageId,
        });
        break;
      case "reply":
        await this.handlers.replyToServiceDesk.execute({
          reference: command.issueKey, body: command.body, conversationId, actorId, replyToMessageId,
        });
        break;
    }
    return true;
  }
}
