-- Customer demo: support requests raised from Wire, keyed by their tracker key.
CREATE TABLE "support_requests" (
    "key" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "conversation_dom" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "requester_dom" TEXT NOT NULL,
    "requester_name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status_category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "support_requests_conversation_id_conversation_dom_idx" ON "support_requests"("conversation_id", "conversation_dom");
