import type { QueryPlan } from "./QueryAnalysisPort";

export interface RetrievalResult {
  id: string;
  /**
   * `support_request` carries the stored record only (key, summary, last known status).
   * `jira_ticket` carries live ticket data and is only produced when sharing it with the model is enabled.
   */
  type: "decision" | "action" | "entity" | "signal" | "summary" | "support_request" | "jira_ticket";
  content: string;
  sourceChannel: string;
  sourceDate: Date;
  confidence: number;
  /** Which retrieval paths found this result. Results from ≥2 paths get a 1.5× boost. */
  pathsMatched: string[];
}

export interface RetrievalScope {
  organisationId: string;
  /** Channel boundary — retrieval stays within this channel unless personal mode. */
  channelId?: string;
  /** Defined in personal 1:1 mode — restricts results to the user's own entities. */
  userId?: string;
}

export interface RetrievalPort {
  retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]>;
}
