-- Customer demo: the assignee last seen by the watch, and when the bot opened the direct
-- conversation between requester and agent (at most once per request).
ALTER TABLE "support_requests" ADD COLUMN "assignee_account_id" TEXT;
ALTER TABLE "support_requests" ADD COLUMN "agent_conversation_at" TIMESTAMP(3);
