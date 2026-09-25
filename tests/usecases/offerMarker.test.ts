import { describe, expect, it } from "vitest";
import { parseOfferMarker, REPLY_BODY_MAX } from "../../src/application/services/offers";
import { SUPPORT_DESCRIPTION_MAX, SUPPORT_SUMMARY_MAX } from "../../src/domain/entities/SupportRequest";

const marker = (value: unknown): string => `OFFER: ${JSON.stringify(value)}`;

describe("parseOfferMarker", () => {
  it("separates a support offer on the last line from the answer", () => {
    expect(parseOfferMarker(`I can raise that.\n${marker({ kind: "support", summary: "VPN drops", description: "My VPN drops every ten minutes." })}`)).toEqual({
      text: "I can raise that.",
      command: { kind: "support", summary: "VPN drops", description: "My VPN drops every ten minutes." },
    });
  });

  it("collapses whitespace in the summary to one line and trims the description", () => {
    const command = parseOfferMarker(marker({ kind: "support", summary: "  VPN \n drops\tagain ", description: "  Line one.\nLine two.  " })).command;
    expect(command).toEqual({ kind: "support", summary: "VPN drops again", description: "Line one.\nLine two." });
  });

  it("accepts reply and resolve offers and normalises keys", () => {
    expect(parseOfferMarker(`ok\n${marker({ kind: "reply", issueKey: "ds-4", body: "  The draft is attached.  " })}`).command)
      .toEqual({ kind: "reply", issueKey: "DS-4", body: "The draft is attached." });
    expect(parseOfferMarker(`ok\n${marker({ kind: "resolve", issueKey: " ds-6 " })}`).command).toEqual({ kind: "resolve", issueKey: "DS-6" });
  });

  it("accepts a summary and description at their limits", () => {
    const summary = "s".repeat(SUPPORT_SUMMARY_MAX);
    const description = "d".repeat(SUPPORT_DESCRIPTION_MAX);
    expect(parseOfferMarker(marker({ kind: "support", summary, description })).command).toEqual({ kind: "support", summary, description });
    const body = "b".repeat(REPLY_BODY_MAX);
    expect(parseOfferMarker(marker({ kind: "reply", issueKey: "DS-4", body })).command).toEqual({ kind: "reply", issueKey: "DS-4", body });
  });

  it("ignores trailing blank lines after the marker", () => {
    expect(parseOfferMarker(`ok\n${marker({ kind: "resolve", issueKey: "DS-1" })}\n\n  \n`).command).toEqual({ kind: "resolve", issueKey: "DS-1" });
  });

  it("returns the answer unchanged when there is no marker", () => {
    expect(parseOfferMarker("Nothing to offer.")).toEqual({ text: "Nothing to offer.", command: null });
  });

  it.each([
    ["malformed JSON", "OFFER: {kind: support}"],
    ["an array", "OFFER: []"],
    ["an unknown kind", marker({ kind: "delete", issueKey: "DS-1" })],
    ["the old raise kind", marker({ kind: "raise", actionId: "ACT-0010" })],
    ["the old close kind", marker({ kind: "close", actionId: "ACT-0010" })],
    ["a support offer without a summary", marker({ kind: "support", summary: "   ", description: "It breaks." })],
    ["a support offer without a description", marker({ kind: "support", summary: "It breaks", description: " " })],
    ["a support offer with a non-string summary", marker({ kind: "support", summary: 42, description: "It breaks." })],
    ["a summary that is too long", marker({ kind: "support", summary: "s".repeat(SUPPORT_SUMMARY_MAX + 1), description: "It breaks." })],
    ["a description that is too long", marker({ kind: "support", summary: "It breaks", description: "d".repeat(SUPPORT_DESCRIPTION_MAX + 1) })],
    ["a reply without a body", marker({ kind: "reply", issueKey: "DS-4", body: "   " })],
    ["a reply with a malformed key", marker({ kind: "reply", issueKey: "DS4", body: "hi" })],
    ["a reply that is too long", marker({ kind: "reply", issueKey: "DS-4", body: "x".repeat(REPLY_BODY_MAX + 1) })],
    ["a resolve without a key", marker({ kind: "resolve" })],
    ["a resolve with an action ID", marker({ kind: "resolve", issueKey: "ACT0010" })],
  ])("honours no command for %s, and still hides the marker", (_label, line) => {
    expect(parseOfferMarker(`Answer.\n${line}`)).toEqual({ text: "Answer.", command: null });
  });

  it("only honours a marker on the last line, but never shows one anywhere", () => {
    expect(parseOfferMarker(`${marker({ kind: "resolve", issueKey: "DS-1" })}\nMore text after it.`)).toEqual({
      text: "More text after it.",
      command: null,
    });
  });

  it("parses a marker spread over several lines and hides all of it", () => {
    const answer = 'DS-4 is open.\nOFFER: {\n  "kind": "reply",\n  "issueKey": "DS-4",\n  "body": "The draft is attached."\n}';
    expect(parseOfferMarker(answer)).toEqual({
      text: "DS-4 is open.",
      command: { kind: "reply", issueKey: "DS-4", body: "The draft is attached." },
    });
  });

  it("hides an invalid multi-line marker completely, including its drafted text", () => {
    const answer = 'Answer.\nOFFER: {\n  "kind": "support",\n  "description": "SECRET DRAFT"';
    const parsed = parseOfferMarker(answer);
    expect(parsed).toEqual({ text: "Answer.", command: null });
    expect(parsed.text).not.toContain("SECRET DRAFT");
  });

  it("hides a multi-line marker in the middle of the answer without honouring it", () => {
    const answer = 'Before.\nOFFER: {\n  "kind": "resolve",\n  "issueKey": "DS-1"\n}\nAfter the marker.';
    expect(parseOfferMarker(answer)).toEqual({ text: "Before.\nAfter the marker.", command: null });
  });
});
