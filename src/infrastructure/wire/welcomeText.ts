/** What the welcome says about the service desk; absent when the integration is off. */
export interface SupportWelcome {
  /** Configured project key, used in the command examples. */
  projectKey: string;
  /** Whether the bot notices problems in unmentioned messages (`WIRE_TEAM_BOT_JIRA_PASSIVE`). */
  passive: boolean;
  /** Whether desk replies and status changes are announced (`WIRE_TEAM_BOT_JIRA_WATCH_SECONDS`). */
  watching: boolean;
}

const TEAM_PART =
  "Use decision: or action: to record work. I react 📝 when I save an action from the conversation and ✅ when I save a completion; use my actions to check details. Mention me with pause, secure mode, or resume to control listening. To save the channel purpose, mention me with: context: <brief purpose>.";

/**
 * The message the bot sends when it is added to a channel without a saved purpose. With the
 * service desk configured, that comes first, since it is what the channel is for. The built-in
 * name is replaced by the app's display name on the way out.
 */
export function welcomeText(support?: SupportWelcome): string {
  if (!support) return `I'm Wire Team Bot. ${TEAM_PART}`;
  const raise = support.passive
    ? "Tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes."
    : "Mention me and tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes. `@Wire Team Bot support: <problem>` raises it at once.";
  const follow = `Mention me with \`support requests\` for the open requests or \`status of ${support.projectKey}-N\` for the latest on one, or just ask about a request in your own words.`;
  const updates = support.watching ? " Replies and status changes from the service desk appear here." : "";
  return [
    `I'm Wire Team Bot, and I connect this channel with the service desk. ${raise}`,
    `${follow}${updates}`,
    `I also keep the channel's decisions and actions. ${TEAM_PART}`,
  ].join("\n\n");
}
