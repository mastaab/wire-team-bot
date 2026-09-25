import { describe, expect, it } from "vitest";
import { matchIssueStatusRequest } from "../../src/infrastructure/wire/matchIssueStatusRequest";

describe("matchIssueStatusRequest", () => {
  it.each([
    ["status of DS-4", "DS-4"],
    ["status of ds-4?", "DS-4"],
    ["jira status of DS-4", "DS-4"],
    ["jira status of ACT-0010", "ACT-0010"],
  ])("matches the exact command whether or not the bot is addressed: %s", (text, reference) => {
    expect(matchIssueStatusRequest(text, "DS", false)).toBe(reference);
    expect(matchIssueStatusRequest(text, "DS", true)).toBe(reference);
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
    ["what's the jira status of ACT-0010?", "ACT-0010"],
    ["where does the ticket for ACT-0010 stand", "ACT-0010"],
  ])("matches natural phrasing when addressed: %s", (text, reference) => {
    expect(matchIssueStatusRequest(text, "DS", true)).toBe(reference);
  });

  it.each([
    "whats the status of DS-4",
    "any update on DS-4?",
    "what's the jira status of ACT-0010?",
  ])("leaves natural phrasing between teammates alone when the bot is not addressed: %s", (text) => {
    expect(matchIssueStatusRequest(text, "DS", false)).toBeNull();
  });

  it.each([
    ["a change request", "please close DS-4"],
    ["a reply request", "reply to DS-4 that the draft is attached"],
    ["an escalation", "raise ACT-0010 in jira"],
    ["marking done", "mark DS-4 done"],
    ["another project's key", "what's the status of WPB-1234?"],
    ["a longer project key sharing the prefix", "what's the status of DSX-4?"],
    ["two tickets", "compare DS-4 and DS-3?"],
    ["a key and an action", "is ACT-0010 linked to DS-4?"],
    ["an action without jira or ticket", "what's the status of ACT-0010?"],
    ["the bot's own record IDs", "what's the status of DEC-0001?"],
    ["a statement without a status word", "DS-4 needs the legal review first"],
  ])("does not match %s", (_label, text) => {
    expect(matchIssueStatusRequest(text, "DS", true)).toBeNull();
  });
});
