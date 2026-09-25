import type { IssueReply, IssueSnapshot, IssueStatusCategory, SlaSummary } from "../../ports/IssueTrackerPort";

const REPLY_BODY_MAX = 500;

/** English label for a status category. Tracker status names are localised, so they are never shown. */
export function statusLabel(category: IssueStatusCategory): string {
  switch (category) {
    case "todo": return "To do";
    case "in_progress": return "In progress";
    case "done": return "Done";
  }
}

/** One line per SLA; parts the tracker did not report are omitted. */
export function formatSla(sla: SlaSummary): string {
  const target = sla.goal ? ` (target ${sla.goal})` : "";
  switch (sla.state) {
    case "met":
      return `${sla.name}: met${sla.elapsed ? ` in ${readableDuration(sla.elapsed)}` : ""}${target}`;
    case "breached":
      return `${sla.name}: breached${target}`;
    case "running":
      if (sla.remaining) return `${sla.name}: running, ${sla.remaining} left${sla.goal ? ` of ${sla.goal}` : ""}`;
      return `${sla.name}: running${target}`;
    case "paused":
      return `${sla.name}: paused`;
  }
}

/** Status, SLAs and, when supplied, a block of service-desk replies before the link. */
export function formatIssueStatus(snapshot: IssueSnapshot, replies?: string): string {
  return [
    `**${snapshot.key}** ${snapshot.summary}`,
    `Status: ${statusLabel(snapshot.statusCategory)}`,
    ...snapshot.slas.map(formatSla),
    ...(replies ? ["", replies, ""] : []),
    snapshot.url,
  ].join("\n");
}

/**
 * Customer-facing replies, oldest first, each with author and time in the conversation's
 * timezone and its text quoted. Long replies are cut visibly; the ticket has the full text.
 * Replies the bot sent from Wire are credited to the team, not the bot's tracker account.
 */
export function formatReplies(replies: readonly IssueReply[], timeZone: string): string {
  if (replies.length === 0) return "No replies from the service desk yet.";
  const blocks = replies.map((reply) => {
    const body = reply.body.trim();
    const text = body.length <= REPLY_BODY_MAX ? body : `${body.slice(0, REPLY_BODY_MAX - 3).trimEnd()}...`;
    const quoted = text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
    const author = reply.fromThisBot ? "Your team (via Wire)" : reply.author;
    return `**${author}**, ${formatReplyTime(reply.created, timeZone)}\n${quoted}`;
  });
  return [replies.length === 1 ? "Latest reply from the service desk:" : "Latest replies from the service desk:", ...blocks].join("\n");
}

function formatReplyTime(date: Date, timeZone: string): string {
  const format = (tz: string): string => new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

export function formatResolution(snapshot: IssueSnapshot): string {
  if (snapshot.statusCategory !== "done") {
    return `I'm afraid I couldn't move **${snapshot.key}** to Done in Jira; it is now ${statusLabel(snapshot.statusCategory)}.`;
  }
  return [`Closed **${snapshot.key}** in Jira.`, ...snapshot.slas.map(formatSla)].join("\n");
}

/** Jira rounds durations under a minute down to "0m"; say so plainly instead. */
function readableDuration(friendly: string): string {
  return friendly.trim() === "0m" ? "under a minute" : friendly;
}
