/**
 * Jira Service Management adapter for IssueTrackerPort, using built-in fetch.
 *
 * - Requests are raised through the Service Management API so they enter the queues and
 *   SLAs; the due date and labels are set with a follow-up issue edit because that API only
 *   accepts fields on the customer request form.
 * - Status is read by category only. Status names are localised and never used.
 * - Errors and logs never include request bodies, response bodies or credentials.
 */

import {
  IssueTrackerError,
  type CreateIssueRequest,
  type CreatedIssue,
  type IssueSnapshot,
  type IssueStatusCategory,
  type IssueReply,
  type IssueTrackerPort,
  type SlaSummary,
} from "../../application/ports/IssueTrackerPort";
import type { Logger } from "../../application/ports/Logger";
import type { JiraConfig } from "../../app/config";
import { JIRA_KEY_PATTERN, isKeyInProject } from "../../domain/ids/jiraLink";

export interface JiraAdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  slaPollAttempts?: number;
  slaPollIntervalMs?: number;
}

const SUMMARY_MAX_LENGTH = 255;
const MAX_TRANSITION_HOPS = 3;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 5;

interface JiraStatus {
  id?: string;
  statusCategory?: { key?: string };
}

interface JiraIssue {
  key?: string;
  fields?: { summary?: string; status?: JiraStatus };
}

interface JiraTransition {
  id?: string;
  to?: JiraStatus;
}

interface JiraDuration {
  friendly?: string;
}

interface JiraSlaCycle {
  breached?: boolean;
  paused?: boolean;
  goalDuration?: JiraDuration;
  elapsedTime?: JiraDuration;
  remainingTime?: JiraDuration;
}

interface JiraSla {
  name?: string;
  ongoingCycle?: JiraSlaCycle;
  completedCycles?: JiraSlaCycle[];
}

interface JiraComment {
  public?: unknown;
  body?: unknown;
  author?: { displayName?: string };
  created?: { epochMillis?: number; iso8601?: string };
}

interface JiraResponse<T> {
  status: number;
  data: T | null;
}

function toCategory(key: string | undefined): IssueStatusCategory {
  if (key === "indeterminate") return "in_progress";
  if (key === "done") return "done";
  return "todo";
}

function toSla(entry: JiraSla): SlaSummary | null {
  const name = entry.name ?? "SLA";
  const ongoing = entry.ongoingCycle;
  if (ongoing) {
    const state = ongoing.paused ? "paused" : ongoing.breached ? "breached" : "running";
    return {
      name, state,
      elapsed: ongoing.elapsedTime?.friendly,
      remaining: ongoing.remainingTime?.friendly,
      goal: ongoing.goalDuration?.friendly,
    };
  }
  const cycles = entry.completedCycles ?? [];
  const last = cycles[cycles.length - 1];
  if (!last) return null;
  return {
    name,
    state: last.breached ? "breached" : "met",
    elapsed: last.elapsedTime?.friendly,
    goal: last.goalDuration?.friendly,
  };
}

/** Jira rejects summaries over 255 characters; cut long ones visibly rather than silently. */
function truncateSummary(summary: string): string {
  const text = summary.trim();
  return text.length <= SUMMARY_MAX_LENGTH ? text : `${text.slice(0, SUMMARY_MAX_LENGTH - 3).trimEnd()}...`;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class JiraServiceManagementAdapter implements IssueTrackerPort {
  readonly projectKey: string;
  private readonly authorization: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly slaPollAttempts: number;
  private readonly slaPollIntervalMs: number;

  constructor(
    private readonly config: JiraConfig,
    private readonly logger: Logger,
    options: JiraAdapterOptions = {},
  ) {
    this.projectKey = config.projectKey;
    this.authorization = config.email
      ? `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`
      : `Bearer ${config.apiToken}`;
    this.sleep = options.sleep ?? defaultSleep;
    this.slaPollAttempts = options.slaPollAttempts ?? 5;
    this.slaPollIntervalMs = options.slaPollIntervalMs ?? 2000;
  }

  async createIssue(request: CreateIssueRequest): Promise<CreatedIssue> {
    const created = await this.request<{ issueKey?: unknown }>("POST", "/rest/servicedeskapi/request", {
      serviceDeskId: this.config.serviceDeskId,
      requestTypeId: this.config.requestTypeId,
      requestFieldValues: {
        summary: truncateSummary(request.summary),
        description: request.description,
      },
    });
    const key = created.data?.issueKey;
    if (typeof key !== "string" || !JIRA_KEY_PATTERN.test(key)) {
      throw new IssueTrackerError("Jira returned an unexpected response");
    }

    const fields: { duedate?: string; labels?: string[] } = {};
    if (request.dueDate) fields.duedate = request.dueDate;
    if (request.labels && request.labels.length > 0) fields.labels = request.labels;
    let fieldsApplied = true;
    if (Object.keys(fields).length > 0) {
      try {
        await this.request("PUT", `/rest/api/3/issue/${key}`, { fields });
      } catch (err) {
        fieldsApplied = false;
        this.logger.warn("Jira issue created but field update failed", {
          key, status: err instanceof IssueTrackerError ? err.status : undefined,
        });
      }
    }
    return { key, url: this.browseUrl(key), fieldsApplied };
  }

  async getIssue(key: string): Promise<IssueSnapshot | null> {
    this.assertInProject(key);
    const issue = await this.request<JiraIssue>("GET", `/rest/api/3/issue/${key}?fields=summary,status`, undefined, true);
    if (issue.status === 404 || !issue.data) return null;
    return {
      key,
      url: this.browseUrl(key),
      summary: issue.data.fields?.summary ?? "",
      statusCategory: toCategory(issue.data.fields?.status?.statusCategory?.key),
      slas: await this.readSlas(key),
    };
  }

  async resolveIssue(key: string): Promise<IssueSnapshot> {
    this.assertInProject(key);
    const initial = await this.request<JiraIssue>("GET", `/rest/api/3/issue/${key}?fields=status`);
    let current: JiraStatus = initial.data?.fields?.status ?? {};
    const visited = new Set<string>();

    for (let hop = 0; hop < MAX_TRANSITION_HOPS; hop++) {
      if (toCategory(current.statusCategory?.key) === "done") break;
      if (current.id) visited.add(current.id);
      const list = await this.request<{ transitions?: JiraTransition[] }>("GET", `/rest/api/3/issue/${key}/transitions`);
      const transitions = (list.data?.transitions ?? []).filter((t) => typeof t.id === "string");
      const next =
        transitions.find((t) => t.to?.statusCategory?.key === "done") ??
        transitions.find((t) => t.to?.statusCategory?.key === "indeterminate" && !!t.to.id && !visited.has(t.to.id));
      if (!next?.id) break;
      await this.request("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: next.id } });
      current = next.to ?? {};
    }

    let snapshot = await this.requireIssue(key);
    if (snapshot.statusCategory !== "done") return snapshot;
    // SLA recalculation lags the transition by a few seconds, so wait for the clocks to
    // stop. The status is already done; only the SLAs need re-reading.
    for (let attempt = 1; attempt < this.slaPollAttempts && snapshot.slas.some((s) => s.state === "running"); attempt++) {
      await this.sleep(this.slaPollIntervalMs);
      snapshot = { ...snapshot, slas: await this.readSlas(key) };
    }
    return snapshot;
  }

  async listCustomerReplies(key: string, limit: number): Promise<IssueReply[]> {
    this.assertInProject(key);
    if (limit <= 0) return [];
    const replies: IssueReply[] = [];
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const res = await this.request<{ values?: JiraComment[]; isLastPage?: boolean }>(
        "GET",
        `/rest/servicedeskapi/request/${key}/comment?public=true&internal=false&start=${page * COMMENT_PAGE_SIZE}&limit=${COMMENT_PAGE_SIZE}`,
      );
      for (const comment of res.data?.values ?? []) {
        // An agent credential also receives internal notes, and the query filter is not relied
        // on: only a comment explicitly flagged public reaches the customer-facing view.
        if (comment.public !== true || typeof comment.body !== "string" || !comment.body.trim()) continue;
        const millis = comment.created?.epochMillis ?? Date.parse(comment.created?.iso8601 ?? "");
        if (!Number.isFinite(millis)) continue;
        replies.push({ author: comment.author?.displayName?.trim() || "Service desk", created: new Date(millis), body: comment.body });
      }
      if (res.data?.isLastPage !== false) break;
    }
    // The comment order is not documented, so sort explicitly.
    replies.sort((a, b) => a.created.getTime() - b.created.getTime());
    return replies.slice(-limit);
  }

  private async requireIssue(key: string): Promise<IssueSnapshot> {
    const snapshot = await this.getIssue(key);
    if (!snapshot) throw new IssueTrackerError("Jira request failed (404)", 404);
    return snapshot;
  }

  private async readSlas(key: string): Promise<SlaSummary[]> {
    try {
      const res = await this.request<{ values?: JiraSla[] }>("GET", `/rest/servicedeskapi/request/${key}/sla`);
      return (res.data?.values ?? []).map(toSla).filter((s): s is SlaSummary => s !== null);
    } catch (err) {
      this.logger.warn("Jira SLA read failed; reporting no SLAs", {
        key, status: err instanceof IssueTrackerError ? err.status : undefined,
      });
      return [];
    }
  }

  private assertInProject(key: string): void {
    if (!isKeyInProject(key, this.projectKey)) {
      throw new IssueTrackerError("Issue key is outside the configured project");
    }
  }

  private browseUrl(key: string): string {
    return `${this.config.siteUrl}/browse/${key}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, allowNotFound = false): Promise<JiraResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: "application/json",
      // Without an explicit language Jira localises status names for this account.
      "Accept-Language": "en-GB",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl}${path}`, {
          method, headers, signal: controller.signal,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw this.transportError(err);
      }
      if (allowNotFound && res.status === 404) return { status: 404, data: null };
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new IssueTrackerError(`Jira rejected the credentials or scopes (${res.status})`, res.status);
        }
        throw new IssueTrackerError(`Jira request failed (${res.status})`, res.status);
      }
      if (res.status === 204) return { status: 204, data: null };
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        throw this.transportError(err);
      }
      if (!text) return { status: res.status, data: null };
      try {
        return { status: res.status, data: JSON.parse(text) as T };
      } catch {
        throw new IssueTrackerError("Jira returned an unexpected response", res.status);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private transportError(err: unknown): IssueTrackerError {
    if (err instanceof Error && err.name === "AbortError") return new IssueTrackerError("Jira request timed out");
    return new IssueTrackerError("Jira is unreachable");
  }
}
