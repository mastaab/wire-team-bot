-- Customer demo: when the bot's latest message about a request was stored, to pick the request
-- a posted photo or file most likely belongs to.
ALTER TABLE "support_requests" ADD COLUMN "last_message_at" TIMESTAMP(3);
