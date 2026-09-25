import { sameQualifiedId } from "../../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { jiraKeyFromLinks } from "../../../domain/ids/jiraLink";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { OfferCommand, PendingOfferStore } from "../../services/offers";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { PushActionToJira } from "./PushActionToJira";
import type { ReplyToServiceDesk } from "./ReplyToServiceDesk";
import type { UpdateActionStatus } from "../actions/UpdateActionStatus";

export type Confirmation = "yes" | "no";

export interface ConfirmOfferHandlers {
  /** Re-reads an action before a close; raise and reply re-validate inside their use cases. */
  actions: ActionRepository;
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

/** Explicit forms only: the bot asks "(yes or no)?", so "ok" or "sure" does not approve a write. */
const YES: ReadonlySet<string> = new Set([
  "yes", "yes please", "yep", "yeah", "go ahead", "do it", "please do", "confirm", "confirmed",
]);
const NO: ReadonlySet<string> = new Set(["no", "n", "nope", "no thanks", "cancel", "don't", "do not", "stop"]);

/**
 * Casual replies that answer the offer without deciding it. They never confirm a write; the
 * bot asks again and keeps the offer, instead of dropping it while the requester thinks it
 * is still open.
 */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  "ok", "okay", "k", "sure", "y", "thanks", "thank you", "cheers", "cool", "great", "fine", "alright", "all right",
]);

/** True for a bare acknowledgement such as "ok" or "ok thanks", which is not a decision. */
export function isAcknowledgement(text: string): boolean {
  const normalised = normalise(text);
  if (!normalised) return false;
  return [normalised, normalise(stripCourtesy(normalised))].some((c) => ACKNOWLEDGEMENTS.has(c));
}

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
    const now = this.now();
    if (!answer) {
      if (!isAcknowledgement(input.text) || !this.offers.has(input.conversationId, input.requesterId, now)) return false;
      const pending = this.offers.take(input.conversationId, input.requesterId, now);
      if (!pending) return false;
      // Keep the offer and ask again: an acknowledgement is a response, but not a decision.
      this.offers.put(pending);
      await this.wireOutbound.sendPlainText(input.conversationId, askAgain(pending.command), { replyToMessageId: input.replyToMessageId });
      return true;
    }

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
        if (!(await this.closeStillApplies(command.actionId, conversationId, replyToMessageId))) break;
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

  /**
   * The action may have changed since the offer was made. A close only proceeds for a
   * visible, still-active action that is still linked to a ticket; otherwise it explains why.
   */
  private async closeStillApplies(actionId: string, conversationId: QualifiedId, replyToMessageId?: string): Promise<boolean> {
    const action = await this.handlers.actions.findById(actionId);
    if (!action || action.deleted || !sameQualifiedId(action.conversationId, conversationId)) {
      await this.wireOutbound.sendPlainText(
        conversationId, `I'm afraid I can't find **${actionId}** in this conversation.`, { replyToMessageId },
      );
      return false;
    }
    if (action.status === "done" || action.status === "cancelled" || !jiraKeyFromLinks(action.linkedIds)) {
      await this.wireOutbound.sendPlainText(
        conversationId, `I'm afraid **${action.id}** has changed since I asked, so I haven't changed anything.`, { replyToMessageId },
      );
      return false;
    }
    return true;
  }
}

/** The code-written re-ask after an acknowledgement; it ends with a question like the offer itself. */
function askAgain(command: OfferCommand): string {
  switch (command.kind) {
    case "raise":
      return `I need a clear yes or no, so I haven't raised **${command.actionId}** in Jira yet. Shall I raise it (yes or no)?`;
    case "close":
      return `I need a clear yes or no, so I haven't closed anything yet. Shall I mark **${command.actionId}** done and close its Jira ticket (yes or no)?`;
    case "reply":
      return `I need a clear yes or no, so I haven't sent the reply to **${command.issueKey}** yet. Shall I send it (yes or no)?`;
  }
}
