-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVE';
ALTER TYPE "AuditAction" ADD VALUE 'REJECT';

-- AlterTable
ALTER TABLE "AdminAuditLog" ADD COLUMN     "entityLabel" TEXT,
ADD COLUMN     "requestId" TEXT;

-- AlterTable
ALTER TABLE "BusinessHours" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "assetPlaceholderAr" TEXT;

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_entity_createdAt_idx" ON "AdminAuditLog"("entity", "createdAt");
