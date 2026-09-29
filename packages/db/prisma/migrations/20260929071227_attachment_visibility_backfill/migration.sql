-- Files already on an internal note were uploaded for that note: mark them INTERNAL, so the
-- column added in 20260929063553_attachment_visibility (default PUBLIC) is true for existing rows
-- too. Unlinked uploads and files on public messages stay PUBLIC. Safe to run again.
UPDATE "Attachment" AS a
SET "visibility" = 'INTERNAL'
FROM "Message" AS m
WHERE m."id" = a."messageId"
  AND m."type" = 'INTERNAL'
  AND a."visibility" <> 'INTERNAL';
