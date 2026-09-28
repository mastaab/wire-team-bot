import { describe, it, expect } from "vitest";
import { welcomeText } from "../../src/infrastructure/wire/welcomeText";

describe("welcomeText", () => {
  it("keeps the team welcome when the service desk is not configured", () => {
    const text = welcomeText();
    expect(text).toMatch(/^I'm Wire Team Bot\. Use decision: or action:/);
    expect(text).not.toContain("service desk");
  });

  it("leads with the service desk, offers from ordinary messages and desk updates when passive help and the watch are on", () => {
    const text = welcomeText({ projectKey: "DS", passive: true, watching: true });
    expect(text.startsWith("I'm Wire Team Bot, and I connect this channel with the service desk.")).toBe(true);
    expect(text).toContain("Tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes.");
    expect(text).toContain("`status of DS-N`");
    expect(text).toContain("Replies and status changes from the service desk appear here.");
    expect(text).toContain("Use decision: or action: to record work.");
    expect(text).toContain("pause, secure mode, or resume");
  });

  it("asks for a mention and gives the direct command without passive help, and leaves out updates without the watch", () => {
    const text = welcomeText({ projectKey: "DS", passive: false, watching: false });
    expect(text).toContain("Mention me and tell me about a fault");
    expect(text).toContain("`@Wire Team Bot support: <problem>` raises it at once.");
    expect(text).not.toContain("appear here");
  });
});
