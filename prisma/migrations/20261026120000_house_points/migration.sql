-- CreateEnum
CREATE TYPE "House" AS ENUM ('JOHNSON', 'JEMISON', 'LATIMER', 'DEAN');

-- CreateEnum
CREATE TYPE "HouseCategory" AS ENUM ('SHOW_UP', 'REP_YOUR_HOUSE', 'WIN', 'OWN_THE_MONTH', 'MANUAL');

-- AlterEnum
ALTER TYPE "Permission" ADD VALUE 'HOUSES_WRITE';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "competitionWinners" "House"[] DEFAULT ARRAY[]::"House"[],
ADD COLUMN     "competitionWinnersById" TEXT,
ADD COLUMN     "countsForMonthlyHouse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "countsForRepYourHouse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "countsForShowUp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "houseChangedAt" TIMESTAMP(3),
ADD COLUMN     "houseScoredAt" TIMESTAMP(3),
ADD COLUMN     "houseScoringStale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isHouseCompetition" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HousePointAward" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "house" "House" NOT NULL,
    "category" "HouseCategory" NOT NULL,
    "points" INTEGER NOT NULL,
    "eventId" TEXT,
    "periodMonth" TEXT,
    "attendeeCount" INTEGER,
    "rosterCount" INTEGER,
    "percentage" DECIMAL(7,4),
    "attendeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inputs" JSONB,
    "originalSnapshot" JSONB,
    "recalculatedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "awardedById" TEXT,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeNote" TEXT,

    CONSTRAINT "HousePointAward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HousePointAward_orgId_season_house_idx" ON "HousePointAward"("orgId", "season", "house");

-- CreateIndex
CREATE INDEX "HousePointAward_eventId_idx" ON "HousePointAward"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "HousePointAward_orgId_house_category_eventId_key" ON "HousePointAward"("orgId", "house", "category", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "HousePointAward_orgId_house_category_periodMonth_key" ON "HousePointAward"("orgId", "house", "category", "periodMonth");

-- AddForeignKey
ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_awardedById_fkey" FOREIGN KEY ("awardedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written below this line (Prisma's schema language has no CHECK
-- constraints — same precedent as PointAward_adjustment_fields_check).
--
-- These are what make the two @@unique constraints above a real idempotency
-- guarantee: an event-scoped category with a NULL eventId, or a month award
-- with a NULL periodMonth, would slip past its unique index (NULLs are
-- distinct) and could be inserted any number of times.
-- ---------------------------------------------------------------------------

ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_scope_check" CHECK (
  CASE "category"
    WHEN 'SHOW_UP' THEN "eventId" IS NOT NULL AND "periodMonth" IS NULL
    WHEN 'REP_YOUR_HOUSE' THEN "eventId" IS NOT NULL AND "periodMonth" IS NULL
    WHEN 'WIN' THEN "eventId" IS NOT NULL AND "periodMonth" IS NULL
    WHEN 'OWN_THE_MONTH' THEN "periodMonth" IS NOT NULL AND "eventId" IS NULL
    WHEN 'MANUAL' THEN "periodMonth" IS NULL
  END
);

-- Only a MANUAL award may be negative, and it has to say why (10+ characters)
-- — the same rule as a member point adjustment.
ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_manual_check" CHECK (
  ("category" = 'MANUAL' AND "points" <> 0 AND char_length(btrim("reason")) >= 10)
  OR ("category" <> 'MANUAL' AND "points" >= 0)
);

-- A revoke always carries its note.
ALTER TABLE "HousePointAward" ADD CONSTRAINT "HousePointAward_revoke_note_check" CHECK (
  "revokedAt" IS NULL OR char_length(btrim(coalesce("revokeNote", ''))) > 0
);
