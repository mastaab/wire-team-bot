import { describe, it, expect } from "vitest";
import { findSupportRequestInConversation } from "../../src/application/usecases/jira/supportRequestScope";
import { refreshStatusCategory } from "../../src/application/usecases/jira/supportRequestStatus";
import { OUT_OF_SCOPE, alice, convId, makeAudit, makeLogger, makeRequest, makeRequests } from "./supportRequestFakes";

describe("findSupportRequestInConversation", () => {
  it("returns the request of this conversation, normalising the key", async () => {
    const requests = makeRequests();

    expect(await findSupportRequestInConversation(requests, "  ds-6 ", convId, "DS")).toEqual(makeRequest());
    expect(requests.findByKey).toHaveBeenCalledWith("DS-6");
  });

  it.each(OUT_OF_SCOPE)("returns null for a key %s", async (_label, records, key) => {
    expect(await findSupportRequestInConversation(makeRequests(records), key, convId, "DS")).toBeNull();
  });

  it.each(["", "ACT-0004x", "DS6", "hello"])("does not look up %j", async (key) => {
    const requests = makeRequests();

    expect(await findSupportRequestInConversation(requests, key, convId, "DS")).toBeNull();
    expect(requests.findByKey).not.toHaveBeenCalled();
  });
});

describe("refreshStatusCategory", () => {
  it("writes and audits a changed category", async () => {
    const requests = makeRequests();
    const audit = makeAudit();

    await refreshStatusCategory(requests, audit, makeRequest(), "in_progress", alice);

    expect(requests.updateStatusCategory).toHaveBeenCalledWith("DS-6", "in_progress", expect.any(Date));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorId: alice, conversationId: convId, action: "entity_updated", entityType: "SupportRequest", entityId: "DS-6",
      details: { statusCategory: "in_progress" },
    }));
  });

  it("writes nothing for an unchanged category", async () => {
    const requests = makeRequests();
    const audit = makeAudit();

    await refreshStatusCategory(requests, audit, makeRequest(), "todo", alice);

    expect(requests.updateStatusCategory).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("logs a failed write without throwing", async () => {
    const requests = makeRequests();
    requests.updateStatusCategory.mockRejectedValue(new Error("db down"));
    const audit = makeAudit();
    const logger = makeLogger();

    await expect(refreshStatusCategory(requests, audit, makeRequest(), "done", alice, logger)).resolves.toBeNull();

    expect(audit.append).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Support request status refresh failed", { key: "DS-6", err: "Error" });
  });
});
