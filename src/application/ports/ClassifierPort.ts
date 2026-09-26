/**
 * Port: Tier 1 — classify a single message and decide whether deep extraction is warranted.
 * Returns structured categories and a high-signal flag, NOT a single intent.
 *
 */

export type MessageCategory =
  | "decision"
  | "action"
  | "question"
  | "blocker"
  | "update"
  | "discussion"
  | "reference"
  | "routine"
  /** Someone describes a problem, fault or need a service desk could handle. Only offered to the model when passive service-desk help is on. */
  | "service_request"
  /** Someone asks about the state of a problem or service request. Only offered to the model when passive service-desk help is on. */
  | "request_status";

export interface ClassifyResult {
  /** One or more applicable categories — a message may be both a 'decision' and an 'action'. */
  categories: MessageCategory[];
  /** LLM confidence in the classification (0–1). */
  confidence: number;
  /** Named entities mentioned in the message (used by Tier 2 as hints). */
  entities: string[];
  /** True if categories include 'decision', 'action', 'update', or 'blocker' — triggers Tier 2 extraction. */
  is_high_signal: boolean;
}

export interface ChannelContext {
  timezone?: string;
  channelId: string;
  purpose?: string;
  contextType?: string;
}

export interface ClassifierPort {
  /**
   * Classify a single message.
   * @param text     The message text.
   * @param context  Channel context (purpose, type) for grounding.
   * @param window   Recent messages in the sliding window (for conversation context).
   */
  classify(text: string, context: ChannelContext, window: string[]): Promise<ClassifyResult>;
}
