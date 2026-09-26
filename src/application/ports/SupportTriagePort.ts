/**
 * Port for passive service-desk help: the model reads one unaddressed message and either
 * drafts a support request from it or maps a status question to an open request. It only
 * proposes; code validates the result, and nothing reaches the tracker without a yes.
 */

/** An open support request of the conversation, as shown to the model: key and summary only. */
export interface OpenRequestRef {
  key: string;
  summary: string;
}

export interface SupportDraft {
  /** One line in the speaker's words. */
  summary: string;
  /** Only the problem stated in the message, never the surrounding conversation. */
  description: string;
  /** Key of an open request that already covers this problem, or null. */
  duplicateOf: string | null;
}

export interface SupportTriagePort {
  /** Drafts a request from this single message, or null when it describes no service-desk problem. */
  draftRequest(message: string, openRequests: readonly OpenRequestRef[]): Promise<SupportDraft | null>;
  /** The key of the open request this question asks about, or null when it matches none. */
  matchStatusQuestion(message: string, openRequests: readonly OpenRequestRef[]): Promise<string | null>;
}
