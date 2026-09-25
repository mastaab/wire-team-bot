import { describe, expect, it } from "vitest";
import { parseOfferMarker, REPLY_BODY_MAX } from "../../src/application/services/offers";

describe("parseOfferMarker", () => {
  it("separates a raise offer on the last line from the answer", () => {
    expect(parseOfferMarker('ACT-0010 is open and not yet in Jira.\nOFFER: {"kind":"raise","actionId":"ACT-0010"}')).toEqual({
      text: "ACT-0010 is open and not yet in Jira.",
      command: { kind: "raise", actionId: "ACT-0010" },
    });
  });

  it("accepts close and reply offers and normalises IDs", () => {
    expect(parseOfferMarker('ok\nOFFER: {"kind":"close","actionId":"act-0010"}').command).toEqual({ kind: "close", actionId: "ACT-0010" });
    expect(parseOfferMarker('ok\nOFFER: {"kind":"reply","issueKey":"ds-4","body":"  The draft is attached.  "}').command)
      .toEqual({ kind: "reply", issueKey: "DS-4", body: "The draft is attached." });
  });

  it("ignores trailing blank lines after the marker", () => {
    expect(parseOfferMarker('ok\nOFFER: {"kind":"raise","actionId":"ACT-1"}\n\n  \n').command).toEqual({ kind: "raise", actionId: "ACT-1" });
  });

  it("returns the answer unchanged when there is no marker", () => {
    expect(parseOfferMarker("Nothing to offer.")).toEqual({ text: "Nothing to offer.", command: null });
  });

  it.each([
    ["malformed JSON", "OFFER: {kind: raise}"],
    ["an array", "OFFER: []"],
    ["an unknown kind", 'OFFER: {"kind":"delete","actionId":"ACT-1"}'],
    ["a non-action ID", 'OFFER: {"kind":"raise","actionId":"DEC-0001"}'],
    ["a reply without a body", 'OFFER: {"kind":"reply","issueKey":"DS-4","body":"   "}'],
    ["a reply with a malformed key", 'OFFER: {"kind":"reply","issueKey":"DS4","body":"hi"}'],
    ["a reply that is too long", `OFFER: {"kind":"reply","issueKey":"DS-4","body":"${"x".repeat(REPLY_BODY_MAX + 1)}"}`],
  ])("honours no command for %s, and still hides the marker", (_label, marker) => {
    expect(parseOfferMarker(`Answer.\n${marker}`)).toEqual({ text: "Answer.", command: null });
  });

  it("only honours a marker on the last line, but never shows one anywhere", () => {
    expect(parseOfferMarker('OFFER: {"kind":"raise","actionId":"ACT-1"}\nMore text after it.')).toEqual({
      text: "More text after it.",
      command: null,
    });
  });
});
