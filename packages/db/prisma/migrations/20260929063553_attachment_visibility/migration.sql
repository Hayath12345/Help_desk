-- CreateEnum
CREATE TYPE "AttachmentVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "visibility" "AttachmentVisibility" NOT NULL DEFAULT 'PUBLIC';
