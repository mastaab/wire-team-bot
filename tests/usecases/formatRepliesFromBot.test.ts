import { describe, it, expect } from "vitest";
import { formatReplies } from "../../src/application/usecases/jira/formatIssue";

const created = new Date("2026-09-25T09:00:00Z");

describe("formatReplies with the bot's own replies", () => {
  it("labels a reply sent from Wire as the team's", () => {
    expect(formatReplies([
      { author: "WireTeamBotDemo", created, body: "Section 3 is attached.\n\nSent from Wire (ACT-0004).", fromThisBot: true },
    ], "UTC")).toBe([
      "Latest reply on the ticket:",
      "",
      "**Your team (via Wire)**, 25 Sept, 09:00",
      "> Section 3 is attached.",
    ].join("\n"));
  });

  it("keeps the account name for other replies", () => {
    const expected = "Latest replies on the ticket:\n\n**Dana**, 25 Sept, 09:00\n> First\n\n**Lee**, 25 Sept, 09:00\n> Second";
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

  it("keeps every reply in one unbroken quote and starts each author line outside the quote", () => {
    // Regression from the Wire staging tour: a blank line inside a reply produced an empty "> "
    // line, which ended the quote, and the next author line was pulled into the quote above.
    const text = formatReplies([
      { author: "WireTeamBotDemo", created, body: "NDA is signed.\n\nSent from Wire (ACT-0012).", fromThisBot: true },
      { author: "Dana", created, body: "Thanks.\n\nWe will countersign today." },
    ], "UTC");
    const lines = text.split("\n");
    expect(lines).not.toContain("> ");
    expect(lines).not.toContain(">");
    for (const author of ["**Your team (via Wire)**, 25 Sept, 09:00", "**Dana**, 25 Sept, 09:00"]) {
      expect(lines[lines.indexOf(author) - 1]).toBe("");
    }
    expect(text).toContain("> Thanks.\n> We will countersign today.");
    expect(text).not.toContain("Sent from Wire");
  });

  it("keeps the footer text on replies that were not sent by the bot", () => {
    expect(formatReplies([{ author: "Dana", created, body: "Quoting: Sent from Wire (ACT-1)." }], "UTC")).toContain("Sent from Wire (ACT-1).");
  });
});

