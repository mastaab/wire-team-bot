import { describe, it, expect, vi } from "vitest";
import { ConversationRole } from "@wireapp/wire-apps-js-sdk";
import { createWireConversationAdapter } from "../../src/infrastructure/wire/WireConversationAdapter";
import { CreatedConversations } from "../../src/infrastructure/wire/CreatedConversations";

const group = { id: "group-1", domain: "staging.zinfra.io" };
const driver = { id: "driver-1", domain: "staging.zinfra.io" };

function setup() {
  const manager = {
    searchUsers: vi.fn().mockResolvedValue([
      { id: { id: "other", domain: "staging.zinfra.io" }, name: "Harvey W.", handle: "harveywolff2" },
      { id: { id: "agent-1", domain: "staging.zinfra.io" }, name: "Harvey", handle: "HarveyWolff" },
    ]),
    createGroupConversation: vi.fn().mockResolvedValue(group),
    updateConversationMemberRole: vi.fn().mockResolvedValue(undefined),
    leaveConversation: vi.fn().mockResolvedValue(undefined),
  };
  const created = new CreatedConversations();
  const adapter = createWireConversationAdapter({ current: { manager: manager as never } }, "staging.zinfra.io", created);
  return { manager, created, adapter };
}

describe("WireConversationAdapter contract", () => {
  it("finds a user by exact handle on the bot's domain, ignoring similar handles", async () => {
    const { manager, adapter } = setup();
    expect(await adapter.findUserByHandle("@harveywolff")).toEqual({ id: { id: "agent-1", domain: "staging.zinfra.io" }, name: "Harvey" });
    expect(manager.searchUsers).toHaveBeenCalledWith("harveywolff", "staging.zinfra.io", 10);
    expect(await adapter.findUserByHandle("nobody")).toBeNull();
  });

  it("creates a group, registers it until the app has left, and makes members admins", async () => {
    const { manager, created, adapter } = setup();
    const id = await adapter.createGroup("DS-25 Brake light", [driver]);
    expect(id).toEqual(group);
    expect(manager.createGroupConversation.mock.calls[0]![0]).toBe("DS-25 Brake light");
    expect(manager.createGroupConversation.mock.calls[0]![1][0]).toMatchObject(driver);
    expect(created.has(group)).toBe(true);
    await adapter.makeAdmin(group, driver);
    expect(manager.updateConversationMemberRole).toHaveBeenCalledWith(expect.objectContaining(group), expect.objectContaining(driver), ConversationRole.ADMIN);
    await adapter.leave(group);
    expect(manager.leaveConversation).toHaveBeenCalledWith(expect.objectContaining(group));
    expect(created.has(group)).toBe(false);
  });

  it("keeps the group registered when leaving fails, so the router keeps ignoring it", async () => {
    const { manager, created, adapter } = setup();
    manager.leaveConversation.mockRejectedValue(new Error("offline"));
    await adapter.createGroup("DS-25", [driver]);
    await expect(adapter.leave(group)).rejects.toThrow("offline");
    expect(created.has(group)).toBe(true);
  });

  it("fails plainly without a connection", async () => {
    const adapter = createWireConversationAdapter({ current: null }, "staging.zinfra.io", new CreatedConversations());
    await expect(adapter.createGroup("x", [driver])).rejects.toThrow("Wire is not connected");
  });
});
