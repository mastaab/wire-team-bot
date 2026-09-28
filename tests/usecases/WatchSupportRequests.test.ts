import { describe, it, expect, vi } from "vitest";
import { WatchSupportRequests } from "../../src/application/usecases/jira/WatchSupportRequests";
import type { WatchGuards } from "../../src/application/usecases/jira/WatchSupportRequests";
import { SupportRequestWrites } from "../../src/application/services/SupportRequestWrites";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import type {
  OpenAgentConversation, OpenAgentConversationInput, OpenAgentConversationOutcome,
} from "../../src/application/usecases/jira/OpenAgentConversation";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { ChannelConfig, ChannelState } from "../../src/domain/repositories/ChannelConfigRepository";
import type { IssueChange, IssueReply, IssueStatusCategory } from "../../src/application/ports/IssueTrackerPort";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import {
  convId, created, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire, sentRefFor,
} from "./supportRequestFakes";

const T0 = new Date("2026-09-26T10:00:00Z");
const SEEN = new Date("2026-09-26T09:00:00Z");
const LAST_MESSAGE = { messageId: "raised-1", sha256: "a".repeat(64) };
const SECRET = "PRIVATE_REPLY_TEXT";

/** Channel configs by channel ID; a missing entry means no config. */
function makeChannels(configs: Record<string, Partial<ChannelConfig>> = {}) {
  const get = vi.fn(async (channelId: string): Promise<ChannelConfig | null> => {
    const config = configs[channelId];
    return config ? {
      channelId, organisationId: "wire.com", state: "active", secureRanges: [], timezone: "UTC", locale: "en", ...config,
    } : null;
  });
  return { get, upsert: vi.fn(), setState: vi.fn(), setTimezone: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn() };
}

function setState(channels: ReturnType<typeof makeChannels>, state: ChannelState, timezone = "UTC") {
  channels.get.mockImplementation(async (channelId: string) => ({
    channelId, organisationId: "wire.com", state, secureRanges: [], timezone, locale: "en",
  }));
}

const change = (key: string, statusCategory: IssueStatusCategory, updated: Date): IssueChange => ({ key, statusCategory, updated });
const reply = (author: string, at: string, body: string, fromThisBot = false): IssueReply =>
  ({ author, created: new Date(at), body, fromThisBot });

/** The `since` the watch passes: two minutes before the previous check, for late search results and clock skew. */
const ago = (d: Date) => new Date(d.getTime() - 2 * 60 * 1000);

/** A clock that returns the given times in order and repeats the last one. */
function clock(...times: Date[]) {
  const queue = [...times];
  return vi.fn(() => (queue.length > 1 ? queue.shift()! : queue[0]));
}

function setup(
  records: SupportRequest[],
  options: { channels?: ReturnType<typeof makeChannels>; now?: () => Date; guards?: WatchGuards } = {},
) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  // By default the live read confirms the category the latest change check listed.
  tracker.getIssue.mockImplementation(async (key: string) => {
    const listed = tracker.listChangedSince.mock.settledResults.at(-1);
    const found = listed?.type === "fulfilled" ? (listed.value as IssueChange[]).find((c) => c.key === key) : undefined;
    return makeSnapshot({ key, ...(found ? { statusCategory: found.statusCategory } : {}) });
  });
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const channels = options.channels ?? makeChannels();
  const watcher = new WatchSupportRequests(
    requests, tracker, wire, audit, channels, logger, options.now ?? (() => T0), options.guards,
  );
  return { requests, tracker, wire, sent, audit, logger, channels, watcher };
}

/** A watched request that already has its reply baseline and a stored last message. */
const watched = (overrides: Partial<SupportRequest> = {}) =>
  makeRequest({ lastSeenReplyAt: SEEN, lastMessage: LAST_MESSAGE, ...overrides });

describe("WatchSupportRequests: first check and baseline", () => {
  it("passes no since on the first check and baselines requests without lastSeenReplyAt, without announcing", async () => {
    const { watcher, tracker, requests, wire } = setup([makeRequest(), makeRequest({ key: "DS-7" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0), change("DS-7", "todo", T0)]);
    tracker.listCustomerReplies.mockImplementation(async (key: string) =>
      key === "DS-6" ? [reply("Dana", "2026-09-25T10:00:00Z", "old"), reply("Dana", "2026-09-25T11:00:00Z", "older news")] : []);

    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });

    expect(tracker.listChangedSince).toHaveBeenCalledWith(["DS-6", "DS-7"], undefined);
    expect(tracker.listCustomerReplies).toHaveBeenCalledWith("DS-6", 10);
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("DS-6", new Date("2026-09-25T11:00:00Z"));
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("DS-7", created);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("asks from two minutes before the previous check and ignores changes at or before that", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, wire } = setup([watched()], { now: clock(T0, T0, t1) });
    await watcher.check();
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", ago(T0))]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["DS-6"], ago(T0));
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("still announces a change that reached Jira's search late, within the overlap", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, sent } = setup([watched()], { now: clock(T0, T0, t1) });
    await watcher.check();
    // Updated just before the previous check, but only searchable now.
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", new Date("2026-09-26T09:59:50Z"))]);
    await watcher.check();
    expect(sent).toEqual(["**DS-6** VPN drops every ten minutes\nNow in progress."]);
  });

  it("lists watched requests with resolved ones from the last day", async () => {
    const { watcher, requests } = setup([watched()]);
    await watcher.check();
    expect(requests.listWatched).toHaveBeenCalledWith(new Date("2026-09-25T10:00:00Z"));
  });

  it("advances the check time when there is nothing to watch", async () => {
    const t1 = new Date("2026-09-26T10:01:00Z");
    const records: SupportRequest[] = [];
    const { watcher, tracker } = setup(records, { now: clock(T0, T0, t1) });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(tracker.listChangedSince).not.toHaveBeenCalled();
    records.push(watched());
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["DS-6"], ago(T0));
  });

  it("leaves out records outside the tracker's project", async () => {
    const { watcher, tracker } = setup([watched(), watched({ key: "OPS-1" })]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["DS-6"], undefined);
  });
});

describe("WatchSupportRequests: new replies", () => {
  it("announces a new desk reply once, quoting the last message, then stores the reference and the marker", async () => {
    const { watcher, tracker, requests, wire, sent, audit } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([
      reply("Dana", "2026-09-26T08:00:00Z", "already seen"),
      reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router."),
    ]);

    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });

    expect(sent).toEqual([[
      "**DS-6** VPN drops every ten minutes",
      "",
      "New reply from the service desk:",
      "",
      "**Dana**, 26 Sept, 09:30 UTC",
      "> Please restart the router.",
    ].join("\n")]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { quote: LAST_MESSAGE });
    expect(requests.setLastMessage).toHaveBeenCalledWith("DS-6", sentRefFor(1));
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("DS-6", new Date("2026-09-26T09:30:00Z"));
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not announce the same reply at the next check once the marker has moved", async () => {
    const records = [watched()];
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, sent } = setup(records, { now: clock(T0, T0, T0, T0, t1) });
    requests.advanceLastSeenReplyAt.mockImplementation(async (key: string, at: Date) => {
      const record = records.find((r) => r.key === key)!;
      record.lastSeenReplyAt = at;
    });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", t1)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Once")]);
    await watcher.check();
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toHaveLength(1);
  });

  it("uses the plural heading and shows at most the three newest replies, in the channel's timezone", async () => {
    const channels = makeChannels({ "conv-1@wire.com": { timezone: "Europe/Berlin" } });
    const { watcher, tracker, sent } = setup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([
      reply("Dana", "2026-09-26T09:10:00Z", "one"),
      reply("Dana", "2026-09-26T09:20:00Z", "two"),
      reply("Lee", "2026-09-26T09:30:00Z", "three"),
      reply("Dana", "2026-09-26T09:40:00Z", "four"),
    ]);
    await watcher.check();
    expect(sent[0]).toContain("New replies from the service desk:");
    expect(sent[0]).not.toContain("> one");
    expect(sent[0]).toContain("> two");
    expect(sent[0]).toContain("> four");
    expect(sent[0]).toContain("**Dana**, 26 Sept, 11:40 CEST");
  });

  it("does not announce the bot's own replies or replies at or before the marker, but moves the marker past them", async () => {
    const { watcher, tracker, requests, wire } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([
      reply("Dana", "2026-09-26T09:00:00Z", "at the marker"),
      reply("WireTeamBotDemo", "2026-09-26T09:45:00Z", "Sent from Wire.", true),
    ]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("DS-6", new Date("2026-09-26T09:45:00Z"));
  });

  it("does not move the marker when no newer reply was fetched", async () => {
    const { watcher, tracker, requests } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T08:00:00Z", "old")]);
    await watcher.check();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
  });

  it("posts standalone when no last message is stored and skips the reference when the transport returns none", async () => {
    const { watcher, tracker, requests, wire } = setup([watched({ lastMessage: undefined })]);
    wire.sendPlainText.mockResolvedValueOnce(undefined);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, "**DS-6** VPN drops every ten minutes\nNow in progress.", undefined);
    expect(requests.setLastMessage).not.toHaveBeenCalled();
  });
});

describe("WatchSupportRequests: status changes", () => {
  it("announces work starting and stores the status through the audited refresh", async () => {
    const { watcher, tracker, requests, sent, audit } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    await watcher.check();
    expect(sent).toEqual(["**DS-6** VPN drops every ten minutes\nNow in progress."]);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "in_progress", T0);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity_updated", entityType: "SupportRequest", entityId: "DS-6",
      actorId: { id: "wire-team-bot", domain: "wire.com" }, details: { statusCategory: "in_progress" },
    }));
  });

  it("announces a resolve with the SLA lines", async () => {
    const { watcher, tracker, sent } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done", slas: [
      { name: "Time to first response", state: "met", elapsed: "3m", goal: "4h" },
      { name: "Time to done", state: "breached", goal: "16h" },
    ] }));
    await watcher.check();
    expect(sent).toEqual([[
      "**DS-6** VPN drops every ten minutes",
      "Resolved by the service desk.",
      "Time to first response: met in 3m (target 4h)",
      "Time to done: breached (target 16h)",
    ].join("\n")]);
  });

  it("keeps a status change pending when the live read fails, and announces it at the next check", async () => {
    const { watcher, tracker, sent, requests, logger } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    const follow = tracker.getIssue.getMockImplementation()!;
    tracker.getIssue.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (500)", 500));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "IssueTrackerError", status: 500 });
    tracker.getIssue.mockImplementation(follow);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent[0]).toContain("Resolved by the service desk.");
  });

  it("trusts the live category over a stale listed one", async () => {
    // Listed as done, but the ticket is back in progress by the time it is read.
    const { watcher, tracker, sent, requests } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
  });

  it.each([
    ["done", "todo", "Reopened by the service desk."],
    ["done", "in_progress", "Reopened by the service desk."],
    ["in_progress", "todo", "Moved back to To do."],
  ] as const)("announces %s to %s as %s", async (from, to, line) => {
    const { watcher, tracker, sent } = setup([watched({ statusCategory: from })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", to, T0)]);
    await watcher.check();
    expect(sent).toEqual([`**DS-6** VPN drops every ten minutes\n${line}`]);
  });

  it("puts a status change and a new reply into one message", async () => {
    const { watcher, tracker, sent } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done", slas: [{ name: "Time to done", state: "met", elapsed: "2h", goal: "16h" }] }));
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:50:00Z", "Fixed the tunnel.")]);
    await watcher.check();
    expect(sent).toEqual([[
      "**DS-6** VPN drops every ten minutes",
      "Resolved by the service desk.",
      "Time to done: met in 2h (target 16h)",
      "",
      "New reply from the service desk:",
      "",
      "**Dana**, 26 Sept, 09:50 UTC",
      "> Fixed the tunnel.",
    ].join("\n")]);
  });

  it("stays silent when the status changed inside a category", async () => {
    const { watcher, tracker, wire, requests } = setup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });
});

describe("WatchSupportRequests: paused and secure channels", () => {
  it.each(["paused", "secure"] as const)("posts nothing in a %s channel and catches up after resume", async (state) => {
    const channels = makeChannels();
    setState(channels, state);
    const t1 = new Date("2026-09-26T10:00:30Z");
    const t2 = new Date("2026-09-26T10:01:00Z");
    const { watcher, tracker, requests, sent } = setup([watched()], { channels, now: clock(T0, T0, t1, t1, t2) });
    tracker.listChangedSince.mockResolvedValueOnce([change("DS-6", "in_progress", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Looking into it.")]);

    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(tracker.listCustomerReplies).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();

    // Still paused: still pending, and Jira reports nothing new.
    tracker.listChangedSince.mockResolvedValueOnce([]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);

    // After resume, one catch-up message even though Jira no longer reports the issue as changed.
    setState(channels, "active");
    tracker.listChangedSince.mockResolvedValueOnce([]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["DS-6"], ago(t1));
    expect(sent).toEqual([[
      "**DS-6** VPN drops every ten minutes",
      "Now in progress.",
      "",
      "New reply from the service desk:",
      "",
      "**Dana**, 26 Sept, 09:30 UTC",
      "> Looking into it.",
    ].join("\n")]);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "in_progress", t2);
  });

  it("drops a pending key that is no longer watched", async () => {
    const channels = makeChannels();
    setState(channels, "paused");
    const records = [watched()];
    const { watcher, tracker } = setup(records, { channels });
    tracker.listChangedSince.mockResolvedValueOnce([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    records[0].deleted = true;
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
  });

  it("treats a channel without a config as active", async () => {
    const { watcher, tracker, sent } = setup([watched()], { channels: makeChannels() });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent).toHaveLength(1);
  });
});

describe("WatchSupportRequests: failures", () => {
  it("keeps the markers after a failed send and retries at the next check", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, wire, logger } = setup([watched()], { now: clock(T0, T0, t1) });
    wire.sendPlainText.mockRejectedValueOnce(new Error(`network ${SECRET}`));
    tracker.listChangedSince.mockResolvedValueOnce([change("DS-6", "in_progress", T0)]).mockResolvedValue([]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", SECRET)]);

    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
    expect(requests.setLastMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "Error" });

    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(wire.sendPlainText).toHaveBeenCalledTimes(2);
    // The rejected call bypasses the fake, so the retry is the first message it records.
    expect(requests.setLastMessage).toHaveBeenCalledWith("DS-6", sentRefFor(1));
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "in_progress", t1);
    expect(requests.advanceLastSeenReplyAt).toHaveBeenCalledWith("DS-6", new Date("2026-09-26T09:30:00Z"));
    expect(loggedText(logger)).not.toContain(SECRET);
  });

  it("leaves the last check time after a failed tracker call, so the next check asks from the older time", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const t2 = new Date("2026-09-26T10:01:00Z");
    const t3 = new Date("2026-09-26T10:01:30Z");
    const { watcher, tracker, logger } = setup([watched()], { now: clock(T0, T0, t1, t1, t2, t2, t3) });
    await watcher.check();
    tracker.listChangedSince.mockRejectedValueOnce(new IssueTrackerError("Jira request failed (503)", 503));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "IssueTrackerError", status: 503 });
    await watcher.check();
    expect(tracker.listChangedSince.mock.calls.map((c) => c[1])).toEqual([undefined, ago(T0), ago(T0)]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["DS-6"], ago(t2));
  });

  it("does not let one failing request stop the others", async () => {
    const { watcher, tracker, sent, logger } = setup([watched(), watched({ key: "DS-7", summary: "Printer offline" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0), change("DS-7", "in_progress", T0)]);
    tracker.listCustomerReplies.mockImplementation(async (key: string) => {
      if (key === "DS-6") throw new IssueTrackerError("Jira request failed (500)", 500);
      return [];
    });
    expect(await watcher.check()).toEqual({ announced: 1, pending: 1 });
    expect(sent).toEqual(["**DS-7** Printer offline\nNow in progress."]);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "IssueTrackerError", status: 500 });
  });

  it("marks a request pending when its channel config cannot be read", async () => {
    const channels = makeChannels();
    channels.get.mockRejectedValue(new Error("db down"));
    const { watcher, tracker, wire } = setup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("still counts the update as posted when storing the reference fails", async () => {
    const { watcher, tracker, requests } = setup([watched()]);
    requests.setLastMessage.mockRejectedValue(new Error("db down"));
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(requests.updateStatusCategory).toHaveBeenCalled();
  });

  it("never logs reply text or summaries", async () => {
    const { watcher, tracker, requests, wire, logger } = setup([
      watched({ summary: `summary ${SECRET}` }), watched({ key: "DS-7", summary: `other ${SECRET}` }),
    ]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0), change("DS-7", "in_progress", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", `reply ${SECRET}`)]);
    tracker.getIssue.mockRejectedValue(new Error(SECRET));
    wire.sendPlainText.mockRejectedValue(new Error(SECRET));
    requests.advanceLastSeenReplyAt.mockRejectedValue(new Error(SECRET));
    await watcher.check();
    expect(logger.warn).toHaveBeenCalled();
    expect(loggedText(logger)).not.toContain(SECRET);
  });
});

describe("formatReplies heading", () => {
  it("leaves the status of answer unchanged", async () => {
    const tracker = makeTracker();
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-25T10:00:00Z", "Please restart the router.")]);
    const { wire, sent } = makeWire();
    await new GetIssueStatus(makeRequests(), tracker, wire, makeAudit(), makeLogger())
      .execute({ reference: "DS-6", conversationId: convId });
    expect(sent[0]).toBe([
      "**DS-6** VPN drops every ten minutes",
      "Status: In progress",
      "Time to first response: met in 3m (target 4h)",
      "Time to done: running, 15h left of 16h",
      "",
      "Latest reply on the ticket:",
      "",
      "**Dana**, 25 Sept, 10:00 UTC",
      "> Please restart the router.",
      "",
      "https://jira.test/browse/DS-6",
    ].join("\n"));
  });
});

describe("WatchSupportRequests: review guards", () => {
  it("baselines the status too on first sight, so an old resolve is not announced", async () => {
    const { watcher, tracker, sent, requests } = setup([makeRequest({ statusCategory: "todo" })]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "done", T0);
  });

  it("skips a request the bot is resolving from Wire and keeps it pending", async () => {
    const writes = new SupportRequestWrites();
    const { watcher, tracker, sent, requests } = setup([watched({ statusCategory: "in_progress" })], { guards: { writes } });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    let finish: () => void = () => {};
    const resolving = writes.during("DS-6", () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    finish();
    await resolving;
    expect(writes.has("DS-6")).toBe(false);
  });

  it("does not post when a resolve from Wire starts during the reads", async () => {
    const writes = new SupportRequestWrites();
    const { watcher, tracker, sent } = setup([watched({ statusCategory: "in_progress" })], { guards: { writes } });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    let finish: () => void = () => {};
    tracker.listCustomerReplies.mockImplementation(async () => {
      void writes.during("DS-6", () => new Promise<void>((resolve) => { finish = resolve; }));
      return [];
    });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    finish();
  });

  it("does not post when the channel is paused during the reads", async () => {
    const channels = makeChannels();
    const { watcher, tracker, sent, requests } = setup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0)]);
    tracker.listCustomerReplies.mockImplementation(async () => {
      setState(channels, "paused");
      return [reply("Dana", "2026-09-26T09:30:00Z", "Looking into it.")];
    });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(requests.advanceLastSeenReplyAt).not.toHaveBeenCalled();
  });

  it("treats a channel without a config but with the older secret-mode flag as secure", async () => {
    const conversations = { get: vi.fn().mockResolvedValue({ secretMode: true }), upsert: vi.fn() };
    const { watcher, tracker, sent } = setup([watched()], {
      channels: makeChannels(), guards: { conversations: conversations as unknown as WatchGuards["conversations"] },
    });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(sent).toEqual([]);
    expect(conversations.get).toHaveBeenCalledWith(convId);
  });

  it("uses the record as stored now, so a reply `status of` just showed is not announced again", async () => {
    const records = [watched()];
    const { watcher, tracker, requests, sent } = setup(records);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "todo", T0)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Please restart the router.")]);
    // `status of` ran after the watch listed the request and moved the marker past the reply.
    requests.findByKey.mockResolvedValueOnce({ ...records[0]!, lastSeenReplyAt: new Date("2026-09-26T09:30:00Z") });
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(sent).toEqual([]);
  });
});

describe("WatchSupportRequests: conversations it cannot post to", () => {
  it("does not watch requests of a skipped conversation", async () => {
    const cli = { id: "cli-conv", domain: "cli.local" };
    const { watcher, tracker, sent } = setup([watched(), watched({ key: "DS-7", conversationId: cli })], {
      guards: { skipConversation: (c) => c.domain === "cli.local" },
    });
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0), change("DS-7", "done", T0)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["DS-6"], undefined);
    expect(sent).toEqual(["**DS-6** VPN drops every ten minutes\nNow in progress."]);
  });

  it("gives up after ten failed sends, logging once, and counts no paused checks", async () => {
    const channels = makeChannels();
    const { watcher, tracker, wire, logger } = setup([watched()], { channels });
    wire.sendPlainText.mockRejectedValue(new Error("WireApiException"));
    tracker.listChangedSince.mockResolvedValueOnce([change("DS-6", "in_progress", T0)]).mockResolvedValue([]);
    for (let i = 0; i < 9; i++) expect((await watcher.check()).pending).toBe(1);
    // Paused checks in between do not count as failures.
    setState(channels, "paused");
    expect((await watcher.check()).pending).toBe(1);
    setState(channels, "active");
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(wire.sendPlainText).toHaveBeenCalledTimes(10);
    const givingUp = logger.warn.mock.calls.filter(([msg]) => String(msg).includes("giving up"));
    expect(givingUp).toEqual([[expect.any(String), { key: "DS-6", attempts: 10 }]]);
    await watcher.check();
    expect(wire.sendPlainText).toHaveBeenCalledTimes(10);
  });

  it("resets the failure count after a successful send", async () => {
    const { watcher, tracker, wire, sent } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValueOnce([change("DS-6", "in_progress", T0)]).mockResolvedValue([]);
    wire.sendPlainText.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    await watcher.check();
    await watcher.check();
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent).toHaveLength(1);
  });
});

describe("WatchSupportRequests: direct conversation with the desk agent", () => {
  const AGENT = "jira-agent-1";
  const OTHER = "jira-agent-2";
  const NOTICE_REF = { messageId: "notice-1", sha256: "b".repeat(64) };
  const withAssignee = (key: string, statusCategory: IssueStatusCategory, updated: Date, assigneeAccountId?: string): IssueChange =>
    ({ ...change(key, statusCategory, updated), ...(assigneeAccountId ? { assigneeAccountId } : {}) });

  /** Guards with a mapped agent and a mocked use case; the records follow the bookkeeping writes. */
  function agentSetup(records: SupportRequest[], options: { channels?: ReturnType<typeof makeChannels>; now?: () => Date } = {}) {
    const open = {
      execute: vi.fn(async (input: OpenAgentConversationInput): Promise<OpenAgentConversationOutcome> => {
        const found = records.find((r) => r.key === input.request.key)!;
        found.agentConversationAt = T0;
        found.lastMessage = NOTICE_REF;
        return "opened";
      }),
    };
    const guards: WatchGuards = {
      agents: { handles: new Map([[AGENT, "petra.desk"]]), open: open as unknown as OpenAgentConversation },
    };
    const ctx = setup(records, { ...options, guards });
    ctx.requests.setAssignee.mockImplementation(async (key: string, accountId: string | null) => {
      const found = records.find((r) => r.key === key);
      if (found) found.assigneeAccountId = accountId ?? undefined;
    });
    return { ...ctx, open };
  }

  it("stores the assignee on first sight without opening anything", async () => {
    const { watcher, tracker, requests, open } = agentSetup([makeRequest()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("stores null on first sight when unassigned", async () => {
    const { watcher, tracker, requests, open } = agentSetup([makeRequest()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", null);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("opens once for a newly assigned mapped agent, before the other update, which quotes the notice", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, requests, wire, open } = agentSetup([watched()], { now: clock(T0, T0, t1) });
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("DS-6", "in_progress", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", AGENT);
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(open.execute).toHaveBeenCalledWith({ request: expect.objectContaining({ key: "DS-6" }), agentHandle: "petra.desk" });
    expect(open.execute.mock.invocationCallOrder[0]).toBeLessThan(wire.sendPlainText.mock.invocationCallOrder[0]);
    expect(wire.sendPlainText.mock.calls[0][2]).toEqual({ quote: NOTICE_REF });

    // Jira reports the issue again with the same assignee: nothing more is opened.
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("DS-6", "in_progress", t1, AGENT)]);
    await watcher.check();
    expect(open.execute).toHaveBeenCalledTimes(1);
  });

  it("opens when there is no status or reply update, posting nothing else", async () => {
    const { watcher, tracker, open, wire } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
  });

  it("only stores an unmapped assignee", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0, OTHER)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", OTHER);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not reopen for a request that already has a conversation, after a change of assignee", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched({ assigneeAccountId: OTHER, agentConversationAt: SEEN })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not open for an unchanged assignee", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched({ assigneeAccountId: AGENT })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "in_progress", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("does not open for a request that is done", async () => {
    const { watcher, tracker, requests, open, sent } = agentSetup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "done", T0, AGENT)]);
    await watcher.check();
    expect(tracker.getIssue).toHaveBeenCalledWith("DS-6");
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", AGENT);
    expect(open.execute).not.toHaveBeenCalled();
    expect(sent[0]).toContain("Resolved by the service desk.");
  });

  it("does not open when the live read shows the request done although the change listed it open", async () => {
    const { watcher, tracker, open } = agentSetup([watched({ statusCategory: "in_progress" })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0, AGENT)]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "done" }));
    await watcher.check();
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("defers in a paused channel and opens after resume", async () => {
    const channels = makeChannels();
    setState(channels, "paused");
    const { watcher, tracker, requests, open } = agentSetup([watched()], { channels });
    tracker.listChangedSince.mockResolvedValueOnce([withAssignee("DS-6", "todo", T0, AGENT)]).mockResolvedValue([]);
    expect(await watcher.check()).toEqual({ announced: 0, pending: 1 });
    expect(requests.setAssignee).not.toHaveBeenCalled();
    expect(open.execute).not.toHaveBeenCalled();

    setState(channels, "active");
    expect(await watcher.check()).toEqual({ announced: 0, pending: 0 });
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", AGENT);
    expect(open.execute).toHaveBeenCalledTimes(1);
  });

  it("stores a cleared assignee as null without opening", async () => {
    const { watcher, tracker, requests, open } = agentSetup([watched({ assigneeAccountId: AGENT })]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", null);
    expect(open.execute).not.toHaveBeenCalled();
  });

  it("still posts the status and reply update when opening throws", async () => {
    const { watcher, tracker, open, sent, logger, requests, wire } = agentSetup([watched()]);
    open.execute.mockRejectedValue(new Error("boom"));
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "in_progress", T0, AGENT)]);
    tracker.listCustomerReplies.mockResolvedValue([reply("Dana", "2026-09-26T09:30:00Z", "Looking into it.")]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Now in progress.");
    expect(sent[0]).toContain("Looking into it.");
    expect(wire.sendPlainText.mock.calls[0][2]).toEqual({ quote: LAST_MESSAGE });
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "in_progress", T0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("agent conversation"), { key: "DS-6", err: "Error" });
  });

  it("carries on when storing the assignee fails", async () => {
    const { watcher, tracker, requests, open, sent, logger } = agentSetup([watched()]);
    requests.setAssignee.mockRejectedValue(new Error("db down"));
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "in_progress", T0, AGENT)]);
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(open.execute).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("setAssignee"), { key: "DS-6", err: "Error" });
  });

  it("stores the assignee without the agents setting", async () => {
    const { watcher, tracker, requests } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([withAssignee("DS-6", "todo", T0, AGENT)]);
    await watcher.check();
    expect(requests.setAssignee).toHaveBeenCalledWith("DS-6", AGENT);
  });
});
