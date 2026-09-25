/**
 * Jira links are stored in `Action.linkedIds` next to decision IDs. A bare Jira key
 * pattern also matches "DEC-0001", so links carry an explicit "jira:" prefix.
 */

const PREFIX = "jira:";

/** Jira issue key, e.g. "DS-42". */
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

export function toJiraLink(key: string): string {
  return `${PREFIX}${key.toUpperCase()}`;
}

/** Returns the first linked Jira key, or null when the record has no Jira link. */
export function jiraKeyFromLinks(linkedIds: readonly string[]): string | null {
  for (const id of linkedIds) {
    if (!id.startsWith(PREFIX)) continue;
    const key = id.slice(PREFIX.length);
    if (JIRA_KEY_PATTERN.test(key)) return key;
  }
  return null;
}

/** True when the key belongs to the given Jira project, e.g. ("DS-42", "DS"). */
export function isKeyInProject(key: string, projectKey: string): boolean {
  return JIRA_KEY_PATTERN.test(key) && key.toUpperCase().startsWith(`${projectKey.toUpperCase()}-`);
}
