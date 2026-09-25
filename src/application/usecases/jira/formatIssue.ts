import type { IssueSnapshot, IssueStatusCategory, SlaSummary } from "../../ports/IssueTrackerPort";

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
      return `${sla.name}: met${sla.elapsed ? ` in ${sla.elapsed}` : ""}${target}`;
    case "breached":
      return `${sla.name}: breached${target}`;
    case "running":
      if (sla.remaining) return `${sla.name}: running, ${sla.remaining} left${sla.goal ? ` of ${sla.goal}` : ""}`;
      return `${sla.name}: running${target}`;
    case "paused":
      return `${sla.name}: paused`;
  }
}

export function formatIssueStatus(snapshot: IssueSnapshot): string {
  return [
    `**${snapshot.key}** ${snapshot.summary}`,
    `Status: ${statusLabel(snapshot.statusCategory)}`,
    ...snapshot.slas.map(formatSla),
    snapshot.url,
  ].join("\n");
}

export function formatResolution(snapshot: IssueSnapshot): string {
  if (snapshot.statusCategory !== "done") {
    return `I'm afraid I couldn't move **${snapshot.key}** to Done in Jira; it is now ${statusLabel(snapshot.statusCategory)}.`;
  }
  return [`Closed **${snapshot.key}** in Jira.`, ...snapshot.slas.map(formatSla)].join("\n");
}
