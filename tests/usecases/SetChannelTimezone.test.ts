import { describe, expect, it, vi } from "vitest";
import { SetChannelTimezone } from "../../src/application/usecases/general/SetChannelTimezone";
import type { ChannelConfig } from "../../src/domain/repositories/ChannelConfigRepository";

const conversationId = { id: "conv", domain: "wire.com" };
const actorId = { id: "alice", domain: "wire.com" };
const channelId = "conv@wire.com";
const now = new Date("2026-09-26T16:40:00Z");

const stored: ChannelConfig = {
  channelId, organisationId: "wire.com", state: "paused", secureRanges: [], timezone: "UTC", locale: "en", purpose: "Fleet support",
};

function setup(config: ChannelConfig | null = stored, upsert = vi.fn(async (c: ChannelConfig) => c)) {
  const channelConfig = { get: vi.fn().mockResolvedValue(config), upsert };
  const audit = { append: vi.fn() };
  const wire = { sendPlainText: vi.fn() };
  const useCase = new SetChannelTimezone(channelConfig as never, audit, wire as never, "Europe/Berlin", () => now);
  const reply = () => wire.sendPlainText.mock.calls.at(-1)?.[1];
  return { channelConfig, audit, wire, useCase, reply };
}

describe("SetChannelTimezone", () => {
  it("shows the stored timezone with the current time", async () => {
    const { useCase, wire, channelConfig } = setup();
    await useCase.execute({ conversationId, channelId, actorId, replyToMessageId: "m" });
    expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId, "This channel's timezone is **UTC** (currently 16:40 UTC).", { replyToMessageId: "m" });
    expect(channelConfig.upsert).not.toHaveBeenCalled();
  });

  it("shows the default timezone when the channel has no config", async () => {
    const { useCase, reply } = setup(null);
    await useCase.execute({ conversationId, channelId, actorId });
    expect(reply()).toBe("This channel's timezone is **Europe/Berlin** (currently 18:40 CEST).");
  });

  it("sets a valid zone, keeps the rest of the config, audits and confirms", async () => {
    const { useCase, channelConfig, audit, wire } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin", replyToMessageId: "m" });
    expect(channelConfig.upsert).toHaveBeenCalledExactlyOnceWith({ ...stored, timezone: "Europe/Berlin" });
    expect(audit.append).toHaveBeenCalledExactlyOnceWith({
      timestamp: now, actorId, conversationId, action: "config_changed", entityType: "ChannelConfig", entityId: channelId,
      details: { timezone: { from: "UTC", to: "Europe/Berlin" } },
    });
    expect(wire.sendPlainText).toHaveBeenCalledWith(conversationId, "This channel's timezone is now **Europe/Berlin** (currently 18:40 CEST).", { replyToMessageId: "m" });
  });

  it("canonicalises a lower-case name", async () => {
    const { useCase, channelConfig, reply } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: "america/new_york" });
    expect(channelConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({ timezone: "America/New_York" }));
    expect(reply()).toBe("This channel's timezone is now **America/New_York** (currently 12:40 GMT-4).");
  });

  it.each(["Mars/Olympus", "CEST"])("rejects the unknown name %s without reading or writing", async (name) => {
    const { useCase, channelConfig, audit, reply } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: name });
    expect(reply()).toBe(`I'm afraid I don't know the timezone "${name}". Please use a name such as Europe/Berlin or America/New_York.`);
    expect(channelConfig.get).not.toHaveBeenCalled();
    expect(channelConfig.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not save or audit an unchanged zone", async () => {
    const { useCase, channelConfig, audit, reply } = setup();
    await useCase.execute({ conversationId, channelId, actorId, timezone: "utc" });
    expect(reply()).toBe("This channel's timezone is already **UTC**.");
    expect(channelConfig.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("creates a minimal config when the channel has none", async () => {
    const { useCase, channelConfig, audit } = setup(null);
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/London" });
    expect(channelConfig.upsert).toHaveBeenCalledExactlyOnceWith({
      channelId, organisationId: "wire.com", state: "active", secureRanges: [], timezone: "Europe/London", locale: "en",
    });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ details: { timezone: { from: "Europe/Berlin", to: "Europe/London" } } }));
  });

  it("replies clearly and does not audit when saving fails", async () => {
    const { useCase, audit, reply } = setup(stored, vi.fn().mockRejectedValue(new Error("db down")));
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin" });
    expect(reply()).toBe("I'm afraid I couldn't save the timezone just now. Please try again.");
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("replies clearly and does not write when reading the config fails", async () => {
    const { useCase, channelConfig, audit, reply } = setup();
    channelConfig.get.mockRejectedValue(new Error("db down"));
    await useCase.execute({ conversationId, channelId, actorId, timezone: "Europe/Berlin" });
    expect(reply()).toBe("I'm afraid I couldn't save the timezone just now. Please try again.");
    expect(channelConfig.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });
});
