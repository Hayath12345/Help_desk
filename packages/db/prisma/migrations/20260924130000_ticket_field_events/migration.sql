-- AlterEnum: a TicketEvent for every console edit (spec §7), including impact, site, asset id and
-- custom fields. PostgreSQL 12+ adds several enum values in one transaction.
ALTER TYPE "TicketEventType" ADD VALUE 'IMPACT_CHANGED';
ALTER TYPE "TicketEventType" ADD VALUE 'SITE_CHANGED';
ALTER TYPE "TicketEventType" ADD VALUE 'ASSET_CHANGED';
ALTER TYPE "TicketEventType" ADD VALUE 'CUSTOM_FIELDS_CHANGED';
