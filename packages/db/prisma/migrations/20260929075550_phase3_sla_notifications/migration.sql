-- Phase 3 (SLA & notifications), docs/PHASE3_CONTRACT.md "Data model".
--
-- Ticket: stored at-risk instants per SLA target (D1/D2) and the P1 period (p1Since, last escalation
-- step). Existing tickets keep NULL instants until the SLA scan backfills them (a NULL instant is
-- never "at risk"), and NULL p1Since: only the API sets it when a ticket becomes P1, so tickets
-- that existed before this migration never start an escalation chain (D10).

-- CreateEnum
CREATE TYPE "SlaTarget" AS ENUM ('FIRST_REPLY', 'RESOLUTION');

-- CreateEnum
CREATE TYPE "SlaSignalKind" AS ENUM ('AT_RISK', 'BREACHED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'TEAMS', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ALTER COLUMN "title" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "firstReplyAtRiskAt" TIMESTAMP(3),
ADD COLUMN     "p1EscalationStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "p1Since" TIMESTAMP(3),
ADD COLUMN     "resolveAtRiskAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TicketSlaSignal" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "target" "SlaTarget" NOT NULL,
    "kind" "SlaSignalKind" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSlaSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "ticketId" UUID,
    "userId" UUID,
    "teamId" UUID,
    "recipientMasked" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketSlaSignal_ticketId_target_kind_dueAt_key" ON "TicketSlaSignal"("ticketId", "target", "kind", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_dedupeKey_key" ON "NotificationDelivery"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationDelivery_ticketId_idx" ON "NotificationDelivery"("ticketId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_userId_idx" ON "NotificationDelivery"("userId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_teamId_idx" ON "NotificationDelivery"("teamId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_createdAt_idx" ON "NotificationDelivery"("createdAt");

-- CreateIndex (hand-written): one rule per (priority, team, step). NULLS NOT DISTINCT (Postgres 15+)
-- makes the global chain (teamId IS NULL) unique per step too; Prisma cannot express it, so the
-- schema declares a plain @@unique with the same name and columns.
CREATE UNIQUE INDEX "EscalationRule_priority_teamId_step_key" ON "EscalationRule"("priority", "teamId", "step") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_ticketId_idx" ON "Notification"("ticketId");

-- CreateIndex
CREATE INDEX "Ticket_status_firstReplyAtRiskAt_idx" ON "Ticket"("status", "firstReplyAtRiskAt");

-- CreateIndex
CREATE INDEX "Ticket_status_resolveAtRiskAt_idx" ON "Ticket"("status", "resolveAtRiskAt");

-- AddForeignKey
ALTER TABLE "TicketSlaSignal" ADD CONSTRAINT "TicketSlaSignal_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
