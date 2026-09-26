/**
 * Integration tests for the support-request repository against Postgres.
 * Require DATABASE_URL and a running Postgres. Skip when INTEGRATION_TESTS is not "1".
 */
import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaSupportRequestRepository } from "../../src/infrastructure/persistence/postgres/PrismaSupportRequestRepository";
import { getPrismaClient } from "../../src/infrastructure/persistence/postgres/PrismaClient";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";

describe.skipIf(process.env.INTEGRATION_TESTS !== "1")("SupportRequestRepository integration", () => {
  const repo = new PrismaSupportRequestRepository();
  const runId = randomUUID().slice(0, 8).toUpperCase();
  const conv: QualifiedId = { id: `sr-conv-${runId}`, domain: "synthetic.test" };
  const otherDomainConv: QualifiedId = { id: conv.id, domain: "other.synthetic.test" };
  const alice: QualifiedId = { id: "alice", domain: conv.domain };
  const bob: QualifiedId = { id: "bob", domain: conv.domain };
  const aliceElsewhere: QualifiedId = { id: "alice", domain: "other.synthetic.test" };
  let seq = 0;

  function request(overrides: Partial<SupportRequest> = {}): SupportRequest {
    seq += 1;
    const createdAt = new Date(Date.UTC(2026, 8, 25, 9, seq));
    return {
      key: `ZZTEST-${runId}-${seq}`,
      conversationId: conv,
      requesterId: alice,
      requesterName: "Alice",
      summary: `Printer offline ${seq}`,
      kind: "fault",
      statusCategory: "todo",
      createdAt,
      updatedAt: createdAt,
      deleted: false,
      version: 1,
      ...overrides,
    };
  }

  afterAll(async () => {
    const db = getPrismaClient();
    await db.supportRequest.deleteMany({ where: { key: { startsWith: `ZZTEST-${runId}-` } } });
    await db.$disconnect();
  });

  it("round-trips a record through create and findByKey", async () => {
    const created = request({ requesterName: "", statusCategory: "in_progress" });
    await repo.create(created);
    expect(await repo.findByKey(created.key)).toEqual(created);
    expect(await repo.findByKey(`ZZTEST-${runId}-missing`)).toBeNull();
  });

  it("lists by qualified conversation, newest first, without deleted records", async () => {
    const older = await repo.create(request());
    const newer = await repo.create(request({ requesterId: bob, requesterName: "Bob" }));
    const foreign = await repo.create(request({ conversationId: otherDomainConv }));
    const deleted = await repo.create(request({ deleted: true }));

    const listed = (await repo.listByConversation(conv)).map((r) => r.key);
    expect(listed.indexOf(newer.key)).toBeLessThan(listed.indexOf(older.key));
    expect(listed).toContain(older.key);
    expect(listed).not.toContain(foreign.key);
    expect(listed).not.toContain(deleted.key);
    expect((await repo.findByKey(deleted.key))?.deleted).toBe(true);

    const foreignListed = (await repo.listByConversation(otherDomainConv)).map((r) => r.key);
    expect(foreignListed).toEqual([foreign.key]);

    const limited = await repo.listByConversation(conv, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].createdAt.getTime()).toBeGreaterThanOrEqual(newer.createdAt.getTime());
  });

  it("filters open requests and by requester on id and domain", async () => {
    const open = await repo.create(request({ requesterId: bob, requesterName: "Bob" }));
    const done = await repo.create(request({ requesterId: bob, requesterName: "Bob", statusCategory: "done" }));
    const mine = await repo.create(request({ requesterId: alice }));

    const openKeys = (await repo.listByConversation(conv, { openOnly: true })).map((r) => r.key);
    expect(openKeys).toContain(open.key);
    expect(openKeys).toContain(mine.key);
    expect(openKeys).not.toContain(done.key);

    const bobsOpen = (await repo.listByConversation(conv, { openOnly: true, requesterId: bob })).map((r) => r.key);
    expect(bobsOpen).toContain(open.key);
    expect(bobsOpen).not.toContain(done.key);
    expect(bobsOpen).not.toContain(mine.key);

    const alicesElsewhere = await repo.listByConversation(conv, { requesterId: aliceElsewhere });
    expect(alicesElsewhere).toEqual([]);
  });

  it("updates the status category, bumps the version and returns null for a missing key", async () => {
    const created = await repo.create(request());
    const updatedAt = new Date(Date.UTC(2026, 8, 25, 12, 0));

    const updated = await repo.updateStatusCategory(created.key, "done", updatedAt);
    expect(updated).toEqual({ ...created, statusCategory: "done", updatedAt, version: 2 });
    expect(await repo.findByKey(created.key)).toEqual(updated);
    const openKeys = (await repo.listByConversation(conv, { openOnly: true })).map((r) => r.key);
    expect(openKeys).not.toContain(created.key);

    expect(await repo.updateStatusCategory(`ZZTEST-${runId}-missing`, "done", updatedAt)).toBeNull();
  });

  it("reads an unknown stored category as todo", async () => {
    const created = await repo.create(request());
    await getPrismaClient().supportRequest.update({ where: { key: created.key }, data: { statusCategory: "weird" } });
    expect((await repo.findByKey(created.key))?.statusCategory).toBe("todo");
  });
});
