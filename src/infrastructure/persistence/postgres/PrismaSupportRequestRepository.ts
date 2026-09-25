import type { SupportRequest, SupportRequestStatusCategory } from "../../../domain/entities/SupportRequest";
import type {
  SupportRequestListOptions,
  SupportRequestRepository,
} from "../../../domain/repositories/SupportRequestRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { getPrismaClient } from "./PrismaClient";

const STATUS_CATEGORIES: readonly SupportRequestStatusCategory[] = ["todo", "in_progress", "done"];

/** An unknown stored value reads as "todo" so a bad row never counts as resolved. */
function statusCategoryFromRow(value: string): SupportRequestStatusCategory {
  return (STATUS_CATEGORIES as readonly string[]).includes(value) ? (value as SupportRequestStatusCategory) : "todo";
}

export class PrismaSupportRequestRepository implements SupportRequestRepository {
  private prisma = getPrismaClient();

  async create(request: SupportRequest): Promise<SupportRequest> {
    await this.prisma.supportRequest.create({
      data: {
        key: request.key,
        conversationId: request.conversationId.id,
        conversationDom: request.conversationId.domain,
        requesterId: request.requesterId.id,
        requesterDom: request.requesterId.domain,
        requesterName: request.requesterName,
        summary: request.summary,
        statusCategory: request.statusCategory,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        deleted: request.deleted,
        version: request.version,
      },
    });
    return request;
  }

  async findByKey(key: string): Promise<SupportRequest | null> {
    const row = await this.prisma.supportRequest.findUnique({ where: { key } });
    if (!row) return null;
    return this.fromRow(row);
  }

  async listByConversation(
    conversationId: QualifiedId,
    options: SupportRequestListOptions = {},
  ): Promise<SupportRequest[]> {
    const where: Record<string, unknown> = {
      conversationId: conversationId.id,
      conversationDom: conversationId.domain,
      deleted: false,
    };
    if (options.openOnly) where.statusCategory = { not: "done" };
    if (options.requesterId) {
      where.requesterId = options.requesterId.id;
      where.requesterDom = options.requesterId.domain;
    }
    const take = options.limit ?? 50;
    const rows = await this.prisma.supportRequest.findMany({ where, take, orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.fromRow(r));
  }

  async updateStatusCategory(
    key: string,
    statusCategory: SupportRequestStatusCategory,
    updatedAt: Date,
  ): Promise<SupportRequest | null> {
    // updateMany does not throw on a missing key, unlike update.
    const result = await this.prisma.supportRequest.updateMany({
      where: { key },
      data: { statusCategory, updatedAt, version: { increment: 1 } },
    });
    if (result.count === 0) return null;
    return this.findByKey(key);
  }

  private fromRow(row: {
    key: string;
    conversationId: string;
    conversationDom: string;
    requesterId: string;
    requesterDom: string;
    requesterName: string;
    summary: string;
    statusCategory: string;
    createdAt: Date;
    updatedAt: Date;
    deleted: boolean;
    version: number;
  }): SupportRequest {
    return {
      key: row.key,
      conversationId: { id: row.conversationId, domain: row.conversationDom },
      requesterId: { id: row.requesterId, domain: row.requesterDom },
      requesterName: row.requesterName,
      summary: row.summary,
      statusCategory: statusCategoryFromRow(row.statusCategory),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deleted: row.deleted,
      version: row.version,
    };
  }
}
