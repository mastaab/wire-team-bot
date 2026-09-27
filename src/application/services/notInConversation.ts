/**
 * The reply for a record ID that is not a record of this conversation, whatever the reason
 * (unknown, deleted, or another conversation's), so it never reveals records elsewhere.
 */
export function recordNotInConversation(id: string, noun: "action" | "decision"): string {
  return `I'm afraid **${id.trim().toUpperCase()}** isn't ${noun === "action" ? "an action" : "a decision"} in this conversation.`;
}
