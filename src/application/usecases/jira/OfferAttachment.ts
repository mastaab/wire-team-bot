import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import type { InboundFile, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

/** Contract: see PLAN.md §6 "Photos and documents to the service desk". */
export interface OfferAttachmentInput {
  conversationId: QualifiedId;
  /** Who posted the file; only their next message can confirm. */
  senderId: QualifiedId;
  /** The posted file's message, which the offer replies to. */
  messageId: string;
  /** Already checked by the router: an attachable type, within the size limit, not self-deleting. */
  file: InboundFile;
}

/**
 * Offers to attach a file posted in the channel to the open support request it most likely
 * belongs to: the one with the latest bot message about it (`lastMessageAt`), else the newest
 * open one. Stores an `attach` offer for the sender and replies to the file with the question
 * (`formatAttachQuestion`), then stores the reply as the request's last message. Does nothing
 * without an open request, or while the sender already has a pending offer. True when it offered.
 */
export class OfferAttachment {
  constructor(
    private readonly requests: SupportRequestRepository,
    private readonly offers: PendingOfferStore,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(_input: OfferAttachmentInput): Promise<boolean> {
    throw new Error("OfferAttachment.execute is not implemented yet");
  }
}
