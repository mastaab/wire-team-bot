import { describe, it, expect } from "vitest";
import { ResolveSupportRequest } from "../../src/application/usecases/jira/ResolveSupportRequest";
import { IssueTrackerError } from "../../src/application/ports/IssueTrackerPort";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import { OUT_OF_SCOPE, bob, convId, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire } from "./supportRequestFakes";

const done = makeSnapshot({ statusCategory: "done", slas: [{ name: "Time to done", state: "met", elapsed: "3m", goal: "16h" }] });

function setup(records: SupportRequest[] = [makeRequest()]) {
  const requests = makeRequests(records);
  const tracker = makeTracker();
  tracker.resolveIssue.mockResolvedValue(done);
  const { wire, sent } = makeWire();
  const audit = makeAudit();
  const logger = makeLogger();
  const useCase = new ResolveSupportRequest(requests, tracker, wire, audit, logger);
  return { requests, tracker, wire, sent, audit, logger, useCase };
}

const base = { issueKey: "ds-6", conversationId: convId, actorId: bob, replyToMessageId: "msg-1" };

describe("ResolveSupportRequest", () => {
  it("resolves the request, stores the category, audits the actor and reports the SLA outcome", async () => {
    const { requests, tracker, wire, sent, audit, useCase } = setup();

    expect(await useCase.execute(base)).toEqual(done);

    expect(tracker.resolveIssue).toHaveBeenCalledWith("DS-6");
    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "done", expect.any(Date));
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: bob, conversationId: convId, action: "entity_updated", entityType: "SupportRequest", entityId: "DS-6",
      details: { statusCategory: "done" },
    }));
    expect(sent).toEqual(["Resolved **DS-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
    expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-1" });
  });

  it("reports the actual state when the workflow did not reach done, auditing without a store write for an unchanged category", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "in_progress" })]);
    tracker.resolveIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

    await useCase.execute(base);

    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ details: { statusCategory: "in_progress" } }));
    expect(sent).toEqual(["I'm afraid I couldn't resolve **DS-6** with the service desk; it is now In progress."]);
  });

  it("says a request done by its last known category and live is already resolved, without resolving", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(done);

    expect(await useCase.execute(base)).toBeNull();

    expect(tracker.getIssue).toHaveBeenCalledWith("DS-6");
    expect(sent).toEqual(["**DS-6** is already resolved."]);
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not read live for a request not last known as done", async () => {
    const { tracker, useCase } = setup();

    await useCase.execute(base);

    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(tracker.resolveIssue).toHaveBeenCalledTimes(1);
  });

  it("resolves a request the desk reopened, refreshing the stored category first", async () => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    tracker.getIssue.mockResolvedValue(makeSnapshot({ statusCategory: "in_progress" }));

    expect(await useCase.execute(base)).toEqual(done);

    expect(requests.updateStatusCategory.mock.calls.map((call) => call[1])).toEqual(["in_progress", "done"]);
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({
      actorId: { id: "wire-team-bot", domain: "wire.com" }, entityId: "DS-6", details: { statusCategory: "in_progress" },
    }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      actorId: bob, action: "entity_updated", entityType: "SupportRequest", entityId: "DS-6", details: { statusCategory: "done" },
    }));
    expect(tracker.resolveIssue).toHaveBeenCalledWith("DS-6");
    expect(sent).toEqual(["Resolved **DS-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
  });

  it.each([
    ["the read fails", (tracker: ReturnType<typeof makeTracker>) => tracker.getIssue.mockRejectedValue(new IssueTrackerError("unavailable", 503))],
    ["the ticket is not found", (tracker: ReturnType<typeof makeTracker>) => tracker.getIssue.mockResolvedValue(null)],
  ])("says Jira could not be reached for a request last known as done when %s", async (_label, arrange) => {
    const { requests, tracker, sent, audit, useCase } = setup([makeRequest({ statusCategory: "done" })]);
    arrange(tracker);

    expect(await useCase.execute(base)).toBeNull();

    expect(sent).toEqual(["I'm afraid I couldn't reach Jira to check **DS-6** just now; please try again later."]);
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each(OUT_OF_SCOPE)("refuses a key %s with the scope wording, without calling the tracker", async (_label, records, key) => {
    const { tracker, sent, audit, useCase } = setup(records);

    expect(await useCase.execute({ ...base, issueKey: key })).toBeNull();

    expect(sent).toEqual([`I'm afraid **${key}** isn't a support request in this conversation.`]);
    expect(tracker.resolveIssue).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("audits a failed resolve with the actor and asks to check the ticket", async () => {
    const { requests, tracker, sent, audit, logger, useCase } = setup();
    tracker.resolveIssue.mockRejectedValue(new IssueTrackerError("transition failed", 409));

    expect(await useCase.execute(base)).toBeNull();

    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: bob, action: "entity_updated", entityType: "SupportRequest", entityId: "DS-6", details: { outcome: "resolve_failed" },
    }));
    expect(sent).toEqual(["I'm afraid I couldn't resolve **DS-6** with the service desk; please check the ticket."]);
    expect(logger.warn).toHaveBeenCalledWith("ResolveSupportRequest: resolveIssue failed", { key: "DS-6", err: "IssueTrackerError", status: 409 });
  });

  it("still reports the outcome when storing the category or the audit fails", async () => {
    const { requests, audit, sent, logger, useCase } = setup();
    requests.updateStatusCategory.mockRejectedValue(new Error("db down"));
    audit.append.mockRejectedValue(new Error("audit down"));

    expect(await useCase.execute(base)).toEqual(done);

    expect(sent).toEqual(["Resolved **DS-6** with the service desk.\nTime to done: met in 3m (target 16h)"]);
    expect(logger.warn).toHaveBeenCalledWith("Support request status refresh failed", { key: "DS-6", err: "Error" });
    expect(logger.error).toHaveBeenCalledWith("ResolveSupportRequest: audit append failed", { err: "Error" });
  });
});
