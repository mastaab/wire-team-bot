import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import { formatTimeInZone } from "../../services/formatTimeInZone";

export interface ListMyRemindersInput {
  conversationId: QualifiedId;
  targetId?: QualifiedId;
  timezone?: string;
  replyToMessageId?: string;
}

export class ListMyReminders {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListMyRemindersInput): Promise<void> {
    const list = await this.reminders.query({
      conversationId: input.conversationId,
      targetId: input.targetId,
      statusIn: ["pending"],
    });

    if (list.length === 0) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        "You have no pending reminders in this conversation.",
        { replyToMessageId: input.replyToMessageId },
      );
      return;
    }

    const lines = list
      .sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime())
      .map(
        (r) =>
          `- **${r.id}** — ${r.description} _(${formatTimeInZone(r.triggerAt, input.timezone ?? "UTC", "weekdayDate")})_`,
      );

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      lines.join("\n"),
      { replyToMessageId: input.replyToMessageId },
    );
  }
}
