import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { OfferCommand } from "../../ports/PendingOfferPort";

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
