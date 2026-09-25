import { describe, expect, it } from "vitest";
import { hasMultipleCommands } from "../../src/infrastructure/wire/hasMultipleCommands";

const botId = { id: "bot", domain: "wire.test" };

describe("combined-command guard", () => {
  it.each([
    "remind me in 10 minutes to review docs and tests",
    "decision: use Postgres because transactions are required\nand deployment is familiar",
    "action: review the checklist for Bob",
    "ACT-0001 reassign to Bob",
    "Examples:\nremind me in 10 minutes to review notes\nremind me in 20 minutes to review slides",
    "```\nremind me in 10 minutes to review notes\nremind me in 20 minutes to review slides\n```",
    "> remind me in 10 minutes to review notes\n> remind me in 20 minutes to review slides",
    "We should review notes and then remind the team tomorrow",
  ])("preserves a single command or non-request: %s", text => {
    expect(hasMultipleCommands(text, [], botId)).toBe(false);
  });

  it.each([
    "remind me in 10 minutes to review notes and remind me in 20 minutes to review slides",
    "1. `ACT-0001 done`\n2. `ACT-0002 done`",
    "`ACT-0001` done\n`ACT-0002` done",
    "@Wire Team Bot status\n@Wire Team Bot my actions",
  ])("recognises separate explicit commands: %s", text => {
    expect(hasMultipleCommands(text, [], botId)).toBe(true);
  });

  it("masks command-like person labels using their qualified structured identity", () => {
    const name = "@Someone; remind me in 2 minutes to review";
    const text = `action: review docs for ${name}`;
    const mention = { offset: text.indexOf(name), length: name.length, userId: { id: "person", domain: "wire.test" } };
    expect(hasMultipleCommands(text, [mention], botId)).toBe(false);
  });

  it("does not remove a matching bot ID from another domain", () => {
    const name = "@Someone";
    const text = `action: ask ${name} remind me in 2 minutes to review`;
    const mention = { offset: text.indexOf(name), length: name.length, userId: { id: "bot", domain: "other.test" } };
    expect(hasMultipleCommands(text, [mention], botId)).toBe(false);
  });

  it("ignores malformed mention spans", () => {
    expect(hasMultipleCommands("status", [{ offset: -1, length: 4, userId: botId }], botId)).toBe(false);
  });
  it.each([
    "status of DS-42\nACT-3 done",
    "ACT-3 done\nsupport: VPN drops",
    "resolve DS-6; list decisions",
    "reply to DS-6: fixed\nsupport requests",
  ])("recognises Jira command starts when the integration is configured: %s", text => {
    expect(hasMultipleCommands(text, [], botId, "DS")).toBe(true);
  });

  it.each([
    ["support: VPN drops\nACT-3 done", undefined],
    ["status of WPB-12\nACT-3 done", "DS"],
    ["ACT-0004 to jira and ACT-0005 done", "DS"],
    ["support: VPN drops\nit fails when I resolve DNS names", "DS"],
    ["support: Printer broken and my actions page is blank", "DS"],
    ["support: VPN drops\nACT-3 done", "DS"],
  ])("leaves Jira-like text alone when it is not a configured command: %s (project %s)", (text, project) => {
    expect(hasMultipleCommands(text, [], botId, project)).toBe(false);
  });
});
