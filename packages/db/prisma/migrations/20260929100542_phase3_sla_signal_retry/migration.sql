-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "slaTargetsChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TicketSlaSignal" ADD COLUMN     "enqueuedAt" TIMESTAMP(3),
ADD COLUMN     "notify" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "TicketSlaSignal_notify_enqueuedAt_createdAt_idx" ON "TicketSlaSignal"("notify", "enqueuedAt", "createdAt");
