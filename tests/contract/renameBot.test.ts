import { describe, it, expect } from "vitest";
import { renameBot, usableBotName } from "../../src/infrastructure/wire/renameBot";

const alice = { id: "user-1", domain: "wire.com" };

describe("renameBot", () => {
  it("replaces every built-in name with the display name", () => {
    const out = renameBot("Use `@Wire Team Bot status of DS-6` or `@Wire Team Bot timezone <name>`.", "STCO-Support-Demo");
    expect(out.text).toBe("Use `@STCO-Support-Demo status of DS-6` or `@STCO-Support-Demo timezone <name>`.");
  });

  it("moves mentions after a replacement by the change in length and leaves earlier ones", () => {
    const text = "@Alice asked; send `@Wire Team Bot pause`, @Alice.";
    const second = text.lastIndexOf("@Alice");
    const out = renameBot(text, "Desk", [{ userId: alice, offset: 0, length: 6 }, { userId: alice, offset: second, length: 6 }]);
    expect(out.text).toBe("@Alice asked; send `@Desk pause`, @Alice.");
    expect(out.mentions.map((m) => out.text.slice(m.offset, m.offset + m.length))).toEqual(["@Alice", "@Alice"]);
  });

  it("drops a mention that overlaps a replaced name", () => {
    const out = renameBot("Hi Wire Team Bot", "Desk", [{ userId: alice, offset: 3, length: 13 }]);
    expect(out.mentions).toEqual([]);
  });

  it("leaves text without the built-in name, and the built-in name itself, unchanged", () => {
    expect(renameBot("Resolved DS-6.", "Desk")).toEqual({ text: "Resolved DS-6.", mentions: [] });
    expect(renameBot("@Wire Team Bot pause", "Wire Team Bot").text).toBe("@Wire Team Bot pause");
  });

  it("accepts only a one-line, bounded name without backticks", () => {
    expect(usableBotName("  STCO-Support-Demo ")).toBe("STCO-Support-Demo");
    expect(usableBotName("Desk `x`\nBot")).toBe("Desk x Bot");
    expect(usableBotName("")).toBeUndefined();
    expect(usableBotName("x".repeat(65))).toBeUndefined();
    expect(usableBotName(undefined)).toBeUndefined();
  });
});
