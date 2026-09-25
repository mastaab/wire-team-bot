import { afterEach, describe, it, expect, vi } from "vitest";
import { JiraServiceManagementAdapter } from "../../src/infrastructure/jira/JiraServiceManagementAdapter";
import type { JiraConfig } from "../../src/app/config";

const BASE = "https://api.test/ex/jira/cloud";
const config: JiraConfig = {
  baseUrl: BASE, siteUrl: "https://site.test", apiToken: "synthetic-token",
  projectKey: "DS", serviceDeskId: "184", requestTypeId: "11808", timeoutMs: 1000,
};
const MARKER = "PRIVATE_BODY_MARKER";

type Reply = () => Response;
const json = (body: unknown, status = 200): Reply => () => new Response(JSON.stringify(body), { status });
const empty = (status = 204): Reply => () => new Response(null, { status });

/** Routes "METHOD path" to queued replies; the last reply repeats. */
function stubJira(routes: Record<string, Reply[]>) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const route = `${init.method} ${url.replace(BASE, "")}`;
    const queue = routes[route];
    if (!queue) throw new Error(`Unexpected request ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() });
const adapter = (log = logger(), cfg: JiraConfig = config, attempts = 5) =>
  new JiraServiceManagementAdapter(cfg, log as never, { sleep: async () => {}, slaPollAttempts: attempts });
const calls = (fetch: ReturnType<typeof stubJira>) => fetch.mock.calls.map(([u, i]) => `${i.method} ${u.replace(BASE, "")}`);

const issue = (category: string, id: string, name = "To Do") =>
  json({ key: "DS-1", fields: { summary: "Prepare questionnaire", status: { id, name, statusCategory: { key: category } } } });
const TODO = issue("new", "12841");
const IN_PROGRESS = issue("indeterminate", "12840", "In progress");
const DONE = issue("done", "12837", "Done");
const FROM_TODO = json({ transitions: [
  { id: "81", name: "Start work", to: { id: "12840", name: "In progress", statusCategory: { id: 4, key: "indeterminate" } } },
  { id: "91", name: "In review", to: { id: "12835", name: "Pending", statusCategory: { id: 4, key: "indeterminate" } } },
] });
const FROM_IN_PROGRESS = json({ transitions: [
  { id: "111", name: "In review", to: { id: "12835", name: "Pending", statusCategory: { key: "indeterminate" } } },
  { id: "121", name: "Resolved", to: { id: "12837", name: "Done", statusCategory: { key: "done" } } },
] });
const cycle = { breached: false, goalDuration: { friendly: "16h" }, elapsedTime: { friendly: "3m" }, remainingTime: { friendly: "15h 56m" } };
const SLA_MET = json({ values: [
  { id: "41", name: "Time to done", completedCycles: [cycle] },
  { id: "42", name: "Time to first response", completedCycles: [{ breached: false, goalDuration: { friendly: "4h" }, elapsedTime: { friendly: "3m" } }] },
] });
const SLA_RUNNING = json({ values: [{ id: "41", name: "Time to done", completedCycles: [], ongoingCycle: { ...cycle, paused: false } }] });
const ISSUE_PATH = "/rest/api/3/issue/DS-1?fields=summary,status";
const STATUS_PATH = "/rest/api/3/issue/DS-1?fields=status";
const SLA_PATH = "/rest/servicedeskapi/request/DS-1/sla";
const TRANSITIONS = "/rest/api/3/issue/DS-1/transitions";

afterEach(() => vi.unstubAllGlobals());

describe("JiraServiceManagementAdapter requests", () => {
  it("sends Bearer auth, JSON accept and an English language", async () => {
    const fetch = stubJira({ [`GET ${ISSUE_PATH}`]: [TODO], [`GET ${SLA_PATH}`]: [SLA_MET] });
    await adapter().getIssue("DS-1");
    expect(fetch.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer synthetic-token", Accept: "application/json", "Accept-Language": "en-GB",
    });
  });

  it("uses Basic auth when an email is configured", async () => {
    const fetch = stubJira({ [`GET ${ISSUE_PATH}`]: [TODO], [`GET ${SLA_PATH}`]: [SLA_MET] });
    await adapter(logger(), { ...config, email: "bot@example.test" }).getIssue("DS-1");
    const expected = `Basic ${Buffer.from("bot@example.test:synthetic-token").toString("base64")}`;
    expect((fetch.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(expected);
  });

  it("reports rejected credentials", async () => {
    stubJira({ [`GET ${ISSUE_PATH}`]: [json({ message: MARKER }, 401)] });
    await expect(adapter().getIssue("DS-1")).rejects.toThrow("Jira rejected the credentials or scopes (401)");
  });

  it("reports a timeout", async () => {
    stubJira({ [`GET ${ISSUE_PATH}`]: [() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }] });
    await expect(adapter().getIssue("DS-1")).rejects.toThrow("Jira request timed out");
  });

  it("reports an unreachable host", async () => {
    stubJira({ [`GET ${ISSUE_PATH}`]: [() => { throw new TypeError("fetch failed"); }] });
    await expect(adapter().getIssue("DS-1")).rejects.toThrow("Jira is unreachable");
  });

  it("never exposes response bodies in errors or logs", async () => {
    const log = logger();
    stubJira({
      "POST /rest/servicedeskapi/request": [json({ issueKey: "DS-2" }, 201)],
      "PUT /rest/api/3/issue/DS-2": [json({ errors: { duedate: MARKER } }, 400)],
      [`GET ${ISSUE_PATH}`]: [TODO],
      [`GET ${SLA_PATH}`]: [json({ message: MARKER }, 500)],
      [`GET ${STATUS_PATH}`]: [json({ message: MARKER }, 500)],
    });
    await adapter(log).createIssue({ summary: "S", description: "D", dueDate: "2026-09-30" });
    await adapter(log).getIssue("DS-1");
    const error = await adapter(log).resolveIssue("DS-1").catch((e: Error) => e);
    expect(String((error as Error).message)).toBe("Jira request failed (500)");
    expect(JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls])).not.toContain(MARKER);
  });
});

describe("JiraServiceManagementAdapter.createIssue", () => {
  it("raises a service request then sets the due date and labels", async () => {
    const fetch = stubJira({
      "POST /rest/servicedeskapi/request": [json({ issueId: "10010", issueKey: "DS-2", requestTypeId: "11808", serviceDeskId: "184" }, 201)],
      "PUT /rest/api/3/issue/DS-2": [empty()],
    });
    const result = await adapter().createIssue({
      summary: "x".repeat(300), description: "Owner: Bob", dueDate: "2026-09-30", labels: ["wire-team-bot"],
    });
    expect(result).toEqual({ key: "DS-2", url: "https://site.test/browse/DS-2", fieldsApplied: true });
    const [create, edit] = fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(create).toEqual({
      serviceDeskId: "184", requestTypeId: "11808", requestFieldValues: { summary: `${"x".repeat(252)}...`, description: "Owner: Bob" },
    });
    expect(edit).toEqual({ fields: { duedate: "2026-09-30", labels: ["wire-team-bot"] } });
    expect((fetch.mock.calls[0][1].headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("reports but does not throw when the field update fails", async () => {
    const log = logger();
    stubJira({
      "POST /rest/servicedeskapi/request": [json({ issueKey: "DS-2" }, 201)],
      "PUT /rest/api/3/issue/DS-2": [json({}, 400)],
    });
    const result = await adapter(log).createIssue({ summary: "S", description: "D", labels: ["wire-team-bot"] });
    expect(result.fieldsApplied).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-2", status: 400 });
  });

  it("skips the field update when there is nothing to set", async () => {
    const fetch = stubJira({ "POST /rest/servicedeskapi/request": [json({ issueKey: "DS-2" }, 201)] });
    const result = await adapter().createIssue({ summary: "S", description: "D" });
    expect(result.fieldsApplied).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("JiraServiceManagementAdapter.getIssue", () => {
  it("returns null for a missing issue", async () => {
    stubJira({ [`GET ${ISSUE_PATH}`]: [json({}, 404)] });
    expect(await adapter().getIssue("DS-1")).toBeNull();
  });

  it("rejects keys outside the project without calling Jira", async () => {
    const fetch = stubJira({});
    await expect(adapter().getIssue("OPS-1")).rejects.toThrow("Issue key is outside the configured project");
    await expect(adapter().resolveIssue("DEC-0001")).rejects.toThrow("Issue key is outside the configured project");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["new", "To Do", "todo"],
    ["indeterminate", "In progress", "in_progress"],
    ["done", "已完成", "done"],
    ["undefined", "Done", "todo"],
  ])("maps category %s (status %s) to %s", async (category, name, expected) => {
    stubJira({ [`GET ${ISSUE_PATH}`]: [issue(category, "1", name)], [`GET ${SLA_PATH}`]: [SLA_MET] });
    expect((await adapter().getIssue("DS-1"))?.statusCategory).toBe(expected);
  });

  it("maps met and running SLAs", async () => {
    stubJira({ [`GET ${ISSUE_PATH}`]: [TODO, TODO], [`GET ${SLA_PATH}`]: [SLA_MET, SLA_RUNNING] });
    const met = await adapter().getIssue("DS-1");
    expect(met).toEqual({
      key: "DS-1", url: "https://site.test/browse/DS-1", summary: "Prepare questionnaire", statusCategory: "todo",
      slas: [
        { name: "Time to done", state: "met", elapsed: "3m", goal: "16h" },
        { name: "Time to first response", state: "met", elapsed: "3m", goal: "4h" },
      ],
    });
    expect((await adapter().getIssue("DS-1"))?.slas).toEqual([
      { name: "Time to done", state: "running", elapsed: "3m", remaining: "15h 56m", goal: "16h" },
    ]);
  });

  it("maps breached and paused SLAs and skips empty ones", async () => {
    stubJira({
      [`GET ${ISSUE_PATH}`]: [TODO],
      [`GET ${SLA_PATH}`]: [json({ values: [
        { name: "Done late", completedCycles: [{ ...cycle, breached: false }, { ...cycle, breached: true }] },
        { name: "Running late", ongoingCycle: { ...cycle, breached: true, paused: false } },
        { name: "On hold", ongoingCycle: { ...cycle, breached: true, paused: true } },
        { name: "Not started", completedCycles: [] },
      ] })],
    });
    const slas = (await adapter().getIssue("DS-1"))?.slas;
    expect(slas?.map((s) => [s.name, s.state])).toEqual([["Done late", "breached"], ["Running late", "breached"], ["On hold", "paused"]]);
  });

  it("reports no SLAs when the SLA read fails", async () => {
    const log = logger();
    stubJira({ [`GET ${ISSUE_PATH}`]: [TODO], [`GET ${SLA_PATH}`]: [json({}, 403)] });
    expect((await adapter(log).getIssue("DS-1"))?.slas).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-1", status: 403 });
  });
});

describe("JiraServiceManagementAdapter.resolveIssue", () => {
  const transitionIds = (fetch: ReturnType<typeof stubJira>) => fetch.mock.calls
    .filter(([, init]) => init.method === "POST")
    .map(([, init]) => (JSON.parse(init.body as string) as { transition: { id: string } }).transition.id);

  it("takes two hops from To Do", async () => {
    const fetch = stubJira({
      [`GET ${STATUS_PATH}`]: [TODO],
      [`GET ${TRANSITIONS}`]: [FROM_TODO, FROM_IN_PROGRESS],
      [`POST ${TRANSITIONS}`]: [empty()],
      [`GET ${ISSUE_PATH}`]: [DONE],
      [`GET ${SLA_PATH}`]: [SLA_MET],
    });
    const result = await adapter().resolveIssue("DS-1");
    expect(transitionIds(fetch)).toEqual(["81", "121"]);
    expect(result.statusCategory).toBe("done");
    expect(result.slas.every((s) => s.state === "met")).toBe(true);
  });

  it("takes one hop from In progress", async () => {
    const fetch = stubJira({
      [`GET ${STATUS_PATH}`]: [IN_PROGRESS],
      [`GET ${TRANSITIONS}`]: [FROM_IN_PROGRESS],
      [`POST ${TRANSITIONS}`]: [empty()],
      [`GET ${ISSUE_PATH}`]: [DONE],
      [`GET ${SLA_PATH}`]: [SLA_MET],
    });
    await adapter().resolveIssue("DS-1");
    expect(transitionIds(fetch)).toEqual(["121"]);
  });

  it("does nothing when the issue is already done", async () => {
    const fetch = stubJira({ [`GET ${STATUS_PATH}`]: [DONE], [`GET ${ISSUE_PATH}`]: [DONE], [`GET ${SLA_PATH}`]: [SLA_MET] });
    await adapter().resolveIssue("DS-1");
    expect(calls(fetch)).not.toContain(`GET ${TRANSITIONS}`);
  });

  it("does not bounce between visited in-progress statuses", async () => {
    const toPending = json({ transitions: [{ id: "111", to: { id: "12835", statusCategory: { key: "indeterminate" } } }] });
    const backToInProgress = json({ transitions: [{ id: "131", to: { id: "12840", statusCategory: { key: "indeterminate" } } }] });
    const fetch = stubJira({
      [`GET ${STATUS_PATH}`]: [IN_PROGRESS],
      [`GET ${TRANSITIONS}`]: [toPending, backToInProgress],
      [`POST ${TRANSITIONS}`]: [empty()],
      [`GET ${ISSUE_PATH}`]: [issue("indeterminate", "12835", "Pending")],
      [`GET ${SLA_PATH}`]: [SLA_RUNNING],
    });
    const result = await adapter().resolveIssue("DS-1");
    expect(transitionIds(fetch)).toEqual(["111"]);
    expect(result.statusCategory).toBe("in_progress");
    expect(calls(fetch).filter((c) => c === `GET ${ISSUE_PATH}`)).toHaveLength(1);
  });

  it("stops after three hops", async () => {
    let n = 0;
    const fresh = () => json({ transitions: [{ id: String(++n), to: { id: `s${n}`, statusCategory: { key: "indeterminate" } } }] })();
    const fetch = stubJira({
      [`GET ${STATUS_PATH}`]: [TODO],
      [`GET ${TRANSITIONS}`]: [fresh],
      [`POST ${TRANSITIONS}`]: [empty()],
      [`GET ${ISSUE_PATH}`]: [IN_PROGRESS],
      [`GET ${SLA_PATH}`]: [SLA_RUNNING],
    });
    await adapter().resolveIssue("DS-1");
    expect(transitionIds(fetch)).toEqual(["1", "2", "3"]);
  });

  it("polls SLAs until the clocks stop", async () => {
    const fetch = stubJira({
      [`GET ${STATUS_PATH}`]: [IN_PROGRESS],
      [`GET ${TRANSITIONS}`]: [FROM_IN_PROGRESS],
      [`POST ${TRANSITIONS}`]: [empty()],
      [`GET ${ISSUE_PATH}`]: [DONE],
      [`GET ${SLA_PATH}`]: [SLA_RUNNING, SLA_RUNNING, SLA_MET],
    });
    const result = await adapter().resolveIssue("DS-1");
    expect(result.slas.map((s) => s.state)).toEqual(["met", "met"]);
    expect(calls(fetch).filter((c) => c === `GET ${SLA_PATH}`)).toHaveLength(3);
    // Once the issue is done only the SLAs are re-read, not the issue itself.
    expect(calls(fetch).filter((c) => c === `GET ${ISSUE_PATH}`)).toHaveLength(1);
  });

  it("gives up polling after the attempt limit", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = stubJira({
      [`GET ${STATUS_PATH}`]: [IN_PROGRESS],
      [`GET ${TRANSITIONS}`]: [FROM_IN_PROGRESS],
      [`POST ${TRANSITIONS}`]: [empty()],
      [`GET ${ISSUE_PATH}`]: [DONE],
      [`GET ${SLA_PATH}`]: [SLA_RUNNING],
    });
    const result = await new JiraServiceManagementAdapter(config, logger() as never, { sleep, slaPollAttempts: 3, slaPollIntervalMs: 50 })
      .resolveIssue("DS-1");
    expect(result.slas[0].state).toBe("running");
    expect(calls(fetch).filter((c) => c === `GET ${SLA_PATH}`)).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });
});

describe("JiraServiceManagementAdapter customer replies", () => {
  const COMMENTS = (start: number) => `/rest/servicedeskapi/request/DS-1/comment?public=true&internal=false&start=${start}&limit=100`;
  const comment = (id: string, isPublic: unknown, iso: string, body = `reply ${id}`, accountId = `acc-${id}`) =>
    ({ id, public: isPublic, body, author: { accountId, displayName: `Agent ${id}` }, created: { iso8601: iso, epochMillis: Date.parse(iso) } });
  const MYSELF = "GET /rest/api/3/myself";
  const ME = json({ accountId: "acc-bot", displayName: "WireTeamBotDemo" });

  it("returns only comments explicitly flagged public, never internal notes", async () => {
    stubJira({ [MYSELF]: [ME], [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [
      comment("1", true, "2026-09-25T10:00:00Z"),
      comment("2", false, "2026-09-25T10:05:00Z", `internal ${MARKER}`),
      comment("3", undefined, "2026-09-25T10:06:00Z", `unflagged ${MARKER}`),
      comment("4", "true", "2026-09-25T10:07:00Z", `string flag ${MARKER}`),
      comment("5", true, "2026-09-25T10:10:00Z"),
    ] })] });
    const replies = await adapter().listCustomerReplies("DS-1", 3);
    expect(replies.map((r) => r.body)).toEqual(["reply 1", "reply 5"]);
    expect(JSON.stringify(replies)).not.toContain(MARKER);
    expect(replies[0]).toEqual({ author: "Agent 1", created: new Date("2026-09-25T10:00:00Z"), body: "reply 1", fromThisBot: false });
  });

  it("sorts by creation time and keeps the newest, oldest first", async () => {
    stubJira({ [MYSELF]: [ME], [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [
      comment("c", true, "2026-09-25T12:00:00Z"), comment("a", true, "2026-09-25T09:00:00Z"),
      comment("d", true, "2026-09-25T13:00:00Z"), comment("b", true, "2026-09-25T10:00:00Z"),
    ] })] });
    expect((await adapter().listCustomerReplies("DS-1", 3)).map((r) => r.author)).toEqual(["Agent b", "Agent c", "Agent d"]);
  });

  it("follows pages until the last one, within a bound", async () => {
    const fetch = stubJira({
      [MYSELF]: [ME],
      [`GET ${COMMENTS(0)}`]: [json({ isLastPage: false, values: [comment("1", true, "2026-09-25T09:00:00Z")] })],
      [`GET ${COMMENTS(100)}`]: [json({ isLastPage: true, values: [comment("2", true, "2026-09-25T10:00:00Z")] })],
    });
    expect((await adapter().listCustomerReplies("DS-1", 3)).map((r) => r.author)).toEqual(["Agent 1", "Agent 2"]);
    expect(calls(fetch).filter((c) => c !== MYSELF)).toHaveLength(2);
  });

  it("stops after five pages even if Jira keeps reporting more", async () => {
    const routes: Record<string, Reply[]> = {};
    for (let page = 0; page < 6; page++) routes[`GET ${COMMENTS(page * 100)}`] = [json({ isLastPage: false, values: [] })];
    const fetch = stubJira(routes);
    await adapter().listCustomerReplies("DS-1", 3);
    expect(calls(fetch)).toHaveLength(5);
  });

  it("skips replies without a usable body or date and names an unknown author", async () => {
    stubJira({ [MYSELF]: [ME], [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [
      { id: "1", public: true, body: "  ", created: { iso8601: "2026-09-25T09:00:00Z" } },
      { id: "2", public: true, body: "no date" },
      { id: "3", public: true, body: "kept", created: { iso8601: "2026-09-25T10:00:00Z" } },
    ] })] });
    expect(await adapter().listCustomerReplies("DS-1", 3)).toEqual([
      { author: "Service desk", created: new Date("2026-09-25T10:00:00Z"), body: "kept", fromThisBot: false },
    ]);
  });

  it("rejects keys outside the project without calling Jira, and returns nothing for a zero limit", async () => {
    const fetch = stubJira({});
    await expect(adapter().listCustomerReplies("OPS-1", 3)).rejects.toThrow("outside the configured project");
    expect(await adapter().listCustomerReplies("DS-1", 0)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces failures as tracker errors without the body", async () => {
    stubJira({ [`GET ${COMMENTS(0)}`]: [json({ errorMessage: MARKER }, 403)] });
    await expect(adapter().listCustomerReplies("DS-1", 3)).rejects.toThrow("Jira rejected the credentials or scopes (403)");
  });

  it("marks replies from the bot's own account and no others", async () => {
    stubJira({ [MYSELF]: [ME], [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [
      comment("1", true, "2026-09-25T09:00:00Z", "from wire", "acc-bot"),
      comment("2", true, "2026-09-25T10:00:00Z"),
      { id: "3", public: true, body: "no author", created: { iso8601: "2026-09-25T11:00:00Z" } },
      comment("4", false, "2026-09-25T12:00:00Z", `internal ${MARKER}`, "acc-bot"),
    ] })] });
    const replies = await adapter().listCustomerReplies("DS-1", 5);
    expect(replies.map((r) => [r.body, r.fromThisBot])).toEqual([["from wire", true], ["reply 2", false], ["no author", false]]);
    expect(JSON.stringify(replies)).not.toContain(MARKER);
    expect(JSON.stringify(replies)).not.toContain("acc-");
  });

  it("looks up the bot's own account once per adapter", async () => {
    const fetch = stubJira({ [MYSELF]: [ME], [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [
      comment("1", true, "2026-09-25T09:00:00Z", "from wire", "acc-bot"),
    ] })] });
    const jira = adapter();
    expect((await jira.listCustomerReplies("DS-1", 3))[0].fromThisBot).toBe(true);
    expect((await jira.listCustomerReplies("DS-1", 3))[0].fromThisBot).toBe(true);
    expect(calls(fetch).filter((c) => c === MYSELF)).toHaveLength(1);
  });

  it("still returns replies when the account lookup fails, and retries on the next call", async () => {
    const log = logger();
    const fetch = stubJira({
      [MYSELF]: [json({ message: MARKER }, 500), ME],
      [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [comment("1", true, "2026-09-25T09:00:00Z", "from wire", "acc-bot")] })],
    });
    const jira = adapter(log);
    const first = await jira.listCustomerReplies("DS-1", 3);
    expect(first.map((r) => [r.body, r.fromThisBot])).toEqual([["from wire", false]]);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { status: 500 });
    expect((await jira.listCustomerReplies("DS-1", 3))[0].fromThisBot).toBe(true);
    expect(calls(fetch).filter((c) => c === MYSELF)).toHaveLength(2);
    expect(JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls])).not.toContain(MARKER);
  });

  it("does not look up the account when there are no public replies", async () => {
    const fetch = stubJira({ [`GET ${COMMENTS(0)}`]: [json({ isLastPage: true, values: [
      comment("1", false, "2026-09-25T09:00:00Z", "internal note"),
    ] })] });
    expect(await adapter().listCustomerReplies("DS-1", 3)).toEqual([]);
    expect(calls(fetch)).toEqual([`GET ${COMMENTS(0)}`]);
  });
});

describe("JiraServiceManagementAdapter.addCustomerReply", () => {
  const POST_COMMENT = "POST /rest/servicedeskapi/request/DS-1/comment";

  it("posts a public comment through the Service Management API", async () => {
    const log = logger();
    const fetch = stubJira({ [POST_COMMENT]: [json({ id: "10001", public: true }, 201)] });
    await adapter(log).addCustomerReply("DS-1", `Thanks, on it. ${MARKER}`);
    expect(calls(fetch)).toEqual([POST_COMMENT]);
    const init = fetch.mock.calls[0][1];
    expect(JSON.parse(init.body as string)).toEqual({ body: `Thanks, on it. ${MARKER}`, public: true });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls, log.debug.mock.calls])).not.toContain(MARKER);
  });

  it("accepts any success status", async () => {
    stubJira({ [POST_COMMENT]: [empty(204)] });
    await expect(adapter().addCustomerReply("DS-1", "Done")).resolves.toBeUndefined();
  });

  it("rejects keys outside the project without calling Jira", async () => {
    const fetch = stubJira({});
    await expect(adapter().addCustomerReply("OPS-1", "Hello")).rejects.toThrow("Issue key is outside the configured project");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, "Jira rejected the credentials or scopes (403)"],
    [500, "Jira request failed (500)"],
  ])("maps a %s failure without the request or response body", async (status, message) => {
    const log = logger();
    stubJira({ [POST_COMMENT]: [json({ errorMessage: `echo ${MARKER}` }, status)] });
    const error = await adapter(log).addCustomerReply("DS-1", `reply ${MARKER}`).catch((e: Error) => e);
    expect((error as Error).message).toBe(message);
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls, log.debug.mock.calls])).not.toContain(MARKER);
  });
});
