-- Customer demo: the kind of a support request (question, part or fault).
ALTER TABLE "support_requests" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'fault';
