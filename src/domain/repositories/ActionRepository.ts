import type { Action, ActionStatus } from "../entities/Action";
import type { QualifiedId } from "../ids/QualifiedId";

export interface ActionQuery {
  rawMessageId?: string;
  conversationId?: QualifiedId;
  assigneeId?: QualifiedId;
  creatorId?: QualifiedId;
  statusIn?: ActionStatus[];
  searchText?: string;
  limit?: number;
  deadlineBefore?: Date;
  /** Only actions whose linkedIds contain this exact value, e.g. "jira:DS-42". */
  linkedIdsHas?: string;
}

export interface ActionRepository {
  create(action: Action): Promise<Action>;
  update(action: Action): Promise<Action>;
  findById(id: string): Promise<Action | null>;
  query(criteria: ActionQuery): Promise<Action[]>;
  nextId(): Promise<string>;
}
