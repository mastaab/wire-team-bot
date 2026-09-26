-- Customer demo: markers for announcing Jira changes in Wire. The newest service-desk reply
-- already shown, and the bot's latest message about the request (ID and hash only, no text).
ALTER TABLE "support_requests" ADD COLUMN "last_seen_reply_at" TIMESTAMP(3);
ALTER TABLE "support_requests" ADD COLUMN "last_message_id" TEXT;
ALTER TABLE "support_requests" ADD COLUMN "last_message_sha256" TEXT;
