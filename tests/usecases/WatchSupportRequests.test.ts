import { describe, it, expect, vi } from "vitest";
import { WatchSupportRequests } from "../../src/application/usecases/jira/WatchSupportRequests";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
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

/** A clock that returns the given times in order and repeats the last one. */
function clock(...times: Date[]) {
  const queue = [...times];
  return vi.fn(() => (queue.length > 1 ? queue.shift()! : queue[0]));
}

function setup(records: SupportRequest[], options: { channels?: ReturnType<typeof makeChannels>; now?: () => Date } = {}) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const channels = options.channels ?? makeChannels();
  const watcher = new WatchSupportRequests(
    requests, tracker, wire, audit, channels, logger, options.now ?? (() => T0),
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

  it("asks from the previous check time on the next check and ignores changes at or before it", async () => {
    const t1 = new Date("2026-09-26T10:00:30Z");
    const { watcher, tracker, wire } = setup([watched()], { now: clock(T0, T0, t1) });
    await watcher.check();
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "in_progress", T0)]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["DS-6"], T0);
    expect(wire.sendPlainText).not.toHaveBeenCalled();
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
    expect(tracker.listChangedSince).toHaveBeenCalledWith(["DS-6"], T0);
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

  it("announces a resolve without SLA lines when reading them fails", async () => {
    const { watcher, tracker, sent, logger } = setup([watched()]);
    tracker.listChangedSince.mockResolvedValue([change("DS-6", "done", T0)]);
    tracker.getIssue.mockRejectedValue(new IssueTrackerError("Jira request failed (500)", 500));
    expect(await watcher.check()).toEqual({ announced: 1, pending: 0 });
    expect(sent).toEqual(["**DS-6** VPN drops every ten minutes\nResolved by the service desk."]);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "DS-6", err: "IssueTrackerError", status: 500 });
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
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["DS-6"], t1);
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
    expect(tracker.listChangedSince.mock.calls.map((c) => c[1])).toEqual([undefined, T0, T0]);
    await watcher.check();
    expect(tracker.listChangedSince).toHaveBeenLastCalledWith(["DS-6"], t2);
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
