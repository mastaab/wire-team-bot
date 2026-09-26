import { describe, expect, it } from "vitest";
import { matchIssueStatusRequest } from "../../src/infrastructure/wire/matchIssueStatusRequest";

describe("matchIssueStatusRequest", () => {
  it.each([
    ["status of DS-4", "DS-4"],
    ["status of ds-4?", "DS-4"],
    ["jira status of DS-4", "DS-4"],
  ])("matches the exact command: %s", (text, reference) => {
    expect(matchIssueStatusRequest(text, "DS")).toBe(reference);
  });

  it.each([
    // Verbatim from the Wire staging session that exposed the gap.
    ["whats the status of DS-4", "DS-4"],
    ["whats the status of DS-4 in jira", "DS-4"],
    ["what's the status of DS-4?", "DS-4"],
    ["any update on DS-4?", "DS-4"],
    ["how is DS-4 going", "DS-4"],
    ["has the service desk replied on ds-4?", "DS-4"],
    ["is DS-4 done yet?", "DS-4"],
    ["DS-4?", "DS-4"],
  ])("matches natural phrasing: %s", (text, reference) => {
    expect(matchIssueStatusRequest(text, "DS")).toBe(reference);
  });

  it.each([
    ["a change request", "please close DS-4"],
    ["a reply request", "reply to DS-4 that the draft is attached"],
    ["an escalation", "raise DS-4 again"],
    ["a resolve request", "resolve DS-4 please"],
    ["marking done", "mark DS-4 done"],
    ["another project's key", "what's the status of WPB-1234?"],
    ["a longer project key sharing the prefix", "what's the status of DSX-4?"],
    ["two tickets", "compare DS-4 and DS-3?"],
    ["an action, even with jira wording", "what's the jira status of ACT-0010?"],
    ["the removed action form of the command", "jira status of ACT-0010"],
    ["the bot's own record IDs", "what's the status of DEC-0001?"],
    ["a statement without a status word", "DS-4 needs the legal review first"],
  ])("does not match %s", (_label, text) => {
    expect(matchIssueStatusRequest(text, "DS")).toBeNull();
  });
});
