import { describe, it, expect } from "vitest";
import { formatReplies } from "../../src/application/usecases/jira/formatIssue";

const created = new Date("2026-09-25T09:00:00Z");

describe("formatReplies with the bot's own replies", () => {
  it("labels a reply sent from Wire as the team's", () => {
    expect(formatReplies([
      { author: "WireTeamBotDemo", created, body: "Section 3 is attached.\n\nSent from Wire (ACT-0004).", fromThisBot: true },
    ], "UTC")).toBe([
      "Latest reply from the service desk:",
      "**Your team (via Wire)**, 25 Sept, 09:00",
      "> Section 3 is attached.",
      "> ",
      "> Sent from Wire (ACT-0004).",
    ].join("\n"));
  });

  it("keeps the account name for other replies", () => {
    const expected = "Latest replies from the service desk:\n**Dana**, 25 Sept, 09:00\n> First\n**Lee**, 25 Sept, 09:00\n> Second";
    expect(formatReplies([
      { author: "Dana", created, body: "First" },
      { author: "Lee", created, body: "Second", fromThisBot: false },
    ], "UTC")).toBe(expected);
  });

  it("labels only the bot's reply in a mixed list", () => {
    const text = formatReplies([
      { author: "Dana", created, body: "Please send the form." },
      { author: "WireTeamBotDemo", created, body: "Sent.", fromThisBot: true },
    ], "UTC");
    expect(text).toContain("**Dana**, 25 Sept, 09:00");
    expect(text).toContain("**Your team (via Wire)**, 25 Sept, 09:00");
    expect(text).not.toContain("WireTeamBotDemo");
  });
});
