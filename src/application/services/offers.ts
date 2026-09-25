import type { OfferCommand } from "../ports/PendingOfferPort";
import { JIRA_KEY_PATTERN } from "../../domain/ids/jiraLink";
import { SUPPORT_SUMMARY_MAX } from "../../domain/entities/SupportRequest";

/**
 * Offers let the answer model propose a supported Jira change in plain language. The model
 * only proposes: code validates the proposal against the records, writes the question, and
 * runs the existing audited use case after the requester confirms.
 */

export type { OfferCommand, PendingOffer, PendingOfferStore } from "../ports/PendingOfferPort";

/** How long an offer can be confirmed. */
export const OFFER_TTL_MS = 10 * 60 * 1000;

/** Longest reply the bot will send to a ticket. */
export const REPLY_BODY_MAX = 2000;

/**
 * Longest description a `support` offer may carry. The confirmation question quotes it in
 * full, so it stays well under the `support:` command limit (`SUPPORT_DESCRIPTION_MAX`).
 */
export const OFFER_DESCRIPTION_MAX = 1000;

/** The single line the answer model may end with. Everything after the prefix is JSON. */
export const OFFER_MARKER_PREFIX = "OFFER:";

export interface ParsedAnswer {
  /** The answer with every marker line removed. */
  text: string;
  /** The command from a well-formed marker block that ends the answer, if any. */
  command: OfferCommand | null;
}

/**
 * Separates the model's optional offer marker from its answer. A marker is an `OFFER:` line
 * plus any following JSON continuation lines, since the model may spread the JSON over
 * several lines. Every marker block is removed, so raw JSON is never shown. Only a block that
 * ends the answer (nothing but blank lines after it) is honoured, and only when it is valid
 * JSON of a known shape.
 */
export function parseOfferMarker(answer: string): ParsedAnswer {
  const lines = answer.split(/\r?\n/);
  const kept: string[] = [];
  let command: OfferCommand | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith(OFFER_MARKER_PREFIX)) {
      kept.push(lines[i]!);
      continue;
    }
    const block = [line.slice(OFFER_MARKER_PREFIX.length)];
    // JSON strings cannot contain raw line breaks, so a continuation line of the marker starts
    // with a structural character or a quote.
    while (i + 1 < lines.length && /^[{}[\]",:]/.test(lines[i + 1]!.trim())) block.push(lines[++i]!);
    const endsAnswer = lines.slice(i + 1).every((rest) => !rest.trim());
    command = endsAnswer ? toCommand(block.join("\n")) : null;
  }
  return { text: kept.join("\n").trim(), command };
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
  const issueKey = typeof v.issueKey === "string" ? v.issueKey.trim().toUpperCase() : "";
  switch (v.kind) {
    case "support": {
      const summary = typeof v.summary === "string" ? v.summary.replace(/\s+/g, " ").trim() : "";
      const description = typeof v.description === "string" ? v.description.trim() : "";
      if (!summary || summary.length > SUPPORT_SUMMARY_MAX) return null;
      if (!description || description.length > OFFER_DESCRIPTION_MAX) return null;
      return { kind: "support", summary, description };
    }
    case "reply": {
      const body = typeof v.body === "string" ? v.body.trim() : "";
      if (!JIRA_KEY_PATTERN.test(issueKey) || !body || body.length > REPLY_BODY_MAX) return null;
      return { kind: "reply", issueKey, body };
    }
    case "resolve":
      return JIRA_KEY_PATTERN.test(issueKey) ? { kind: "resolve", issueKey } : null;
    default:
      return null;
  }
}
