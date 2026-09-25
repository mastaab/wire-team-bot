import type { QualifiedId } from "../../domain/ids/QualifiedId";
import { JIRA_KEY_PATTERN } from "../../domain/ids/jiraLink";

/**
 * Offers let the answer model propose a supported Jira change in plain language. The model
 * only proposes: code validates the proposal against the records, writes the question, and
 * runs the existing audited use case after the requester confirms.
 */

export type OfferCommand =
  | { kind: "raise"; actionId: string }
  | { kind: "close"; actionId: string }
  | { kind: "reply"; issueKey: string; body: string };

export interface PendingOffer {
  command: OfferCommand;
  conversationId: QualifiedId;
  /** Only this member's confirmation counts. */
  requesterId: QualifiedId;
  createdAt: Date;
  expiresAt: Date;
}

export interface PendingOfferStore {
  /** Stores the offer, replacing any pending one for the same requester in the conversation. */
  put(offer: PendingOffer): void;
  /** Removes and returns the requester's pending offer, or null if there is none or it expired. */
  take(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): PendingOffer | null;
  /** True when the requester has an unexpired offer, without removing it. */
  has(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): boolean;
  /** Drops every pending offer in the conversation, e.g. when it is paused or made secure. */
  clearConversation(conversationId: QualifiedId): void;
}

/** How long an offer can be confirmed. */
export const OFFER_TTL_MS = 10 * 60 * 1000;

/** Longest reply the bot will send to a ticket. */
export const REPLY_BODY_MAX = 2000;

/** The single line the answer model may end with. Everything after the prefix is JSON. */
export const OFFER_MARKER_PREFIX = "OFFER:";

export interface ParsedAnswer {
  /** The answer with every marker line removed. */
  text: string;
  /** The command from a well-formed marker on the last non-empty line, if any. */
  command: OfferCommand | null;
}

/**
 * Separates the model's optional offer marker from its answer. Only a marker on the last
 * non-empty line is honoured, and only when it is valid JSON of a known shape. Marker lines
 * elsewhere are removed without being honoured, so a raw marker is never shown.
 */
export function parseOfferMarker(answer: string): ParsedAnswer {
  const lines = answer.split(/\r?\n/);
  let lastIndex = lines.length - 1;
  while (lastIndex >= 0 && !lines[lastIndex]!.trim()) lastIndex--;
  const last = lastIndex >= 0 ? lines[lastIndex]!.trim() : "";
  const command = last.startsWith(OFFER_MARKER_PREFIX) ? toCommand(last.slice(OFFER_MARKER_PREFIX.length)) : null;
  const text = lines.filter((line) => !line.trim().startsWith(OFFER_MARKER_PREFIX)).join("\n").trim();
  return { text, command };
}

function toCommand(json: string): OfferCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(json.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const actionId = typeof v.actionId === "string" ? v.actionId.trim().toUpperCase() : "";
  switch (v.kind) {
    case "raise":
    case "close":
      return /^ACT-\d+$/.test(actionId) ? { kind: v.kind, actionId } : null;
    case "reply": {
      const issueKey = typeof v.issueKey === "string" ? v.issueKey.trim().toUpperCase() : "";
      const body = typeof v.body === "string" ? v.body.trim() : "";
      if (!JIRA_KEY_PATTERN.test(issueKey) || !body || body.length > REPLY_BODY_MAX) return null;
      return { kind: "reply", issueKey, body };
    }
    default:
      return null;
  }
}
