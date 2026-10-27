/**
 * Real-Postgres fixtures for the adjustment and trash-bin tests (see
 * vitest.setup.ts for where DATABASE_URL comes from). Each test FILE gets its
 * own Org with its own Config.SEASON, so nothing here can collide with seeded
 * dev data or another file running in parallel; `cleanup()` removes every row
 * the org owns, children first (Registration/PointAward/UploadedFile are
 * RESTRICT on User and Event).
 *
 * Rows are written with prisma directly rather than through registerForEvent:
 * these tests are about what READS do with the rows, and going through the
 * check-in path would drag its code, window and core-form rules into every one.
 */

import { randomUUID } from "node:crypto";
import { AwardKind, GroupKind, Role, UserStatus, EventStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

export const TEST_SEASON = "2026-2027";

export interface TestOrg {
  orgId: string;
  /** A 2-point category that counts for Monthly Champion and the E-Board track. */
  gbmCategoryId: string;
  cleanup: () => Promise<void>;
}

export async function createTestOrg(label: string, season: string = TEST_SEASON): Promise<TestOrg> {
  const org = await prisma.org.create({
    data: { slug: `${label}-${randomUUID()}`, name: `${label} Test Org`, shortName: "TT" },
  });
  const orgId = org.id;
  await prisma.config.create({ data: { orgId, key: "SEASON", value: season } });
  const gbm = await prisma.eventCategory.create({
    data: { orgId, code: "GBM", name: "General Body Meeting", shortName: "GBM", tier: 1, memberPoints: 2, sortOrder: 0 },
  });
  return {
    orgId,
    gbmCategoryId: gbm.id,
    cleanup: async () => {
      const users = { orgId };
      await prisma.registration.deleteMany({ where: { OR: [{ user: users }, { event: { orgId } }] } });
      await prisma.pointAward.deleteMany({ where: { orgId } });
      await prisma.housePointAward.deleteMany({ where: { orgId } });
      await prisma.permissionGrant.deleteMany({ where: { orgId } });
      await prisma.uploadedFile.deleteMany({ where: { orgId } });
      await prisma.event.deleteMany({ where: { orgId } });
      await prisma.eventGroup.deleteMany({ where: { orgId } });
      await prisma.adminLog.deleteMany({ where: { orgId } });
      await prisma.user.deleteMany({ where: { orgId } });
      await prisma.config.deleteMany({ where: { orgId } });
      await prisma.eventCategory.deleteMany({ where: { orgId } });
      await prisma.requestClaim.deleteMany({ where: { orgId } });
      await prisma.org.delete({ where: { id: orgId } });
    },
  };
}

/** A member who is, by default, a fully eligible GENERAL member for TEST_SEASON. */
export async function makeMember(
  orgId: string,
  overrides: Partial<{
    role: Role;
    firstName: string;
    lastName: string;
    eligible: boolean;
    passwordHash: string | null;
    season: string;
  }> = {},
) {
  const eligible = overrides.eligible ?? true;
  return prisma.user.create({
    data: {
      orgId,
      email: `member-${randomUUID()}@bison.howard.edu`,
      passwordHash: overrides.passwordHash ?? null,
      firstName: overrides.firstName ?? "Test",
      lastName: overrides.lastName ?? `Member${randomUUID().slice(0, 6)}`,
      role: overrides.role ?? Role.GENERAL,
      status: UserStatus.ACTIVE,
      duesPaidReported: eligible,
      nationalMemberReported: eligible,
      membershipSeason: eligible ? (overrides.season ?? TEST_SEASON) : null,
      signupCompletedAt: new Date(),
    },
  });
}

/** A past, closed, SCHEDULED event — the ordinary state of an event whose attendance counts. */
export async function makeClosedEvent(
  orgId: string,
  categoryId: string,
  overrides: Partial<{ name: string; closesAt: Date; groupId: string | null }> = {},
) {
  const closesAt = overrides.closesAt ?? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const opensAt = new Date(closesAt.getTime() - 60 * 60 * 1000);
  return prisma.event.create({
    data: {
      orgId,
      slug: `event-${randomUUID()}`,
      name: overrides.name ?? `Event ${randomUUID().slice(0, 6)}`,
      categoryId,
      groupId: overrides.groupId ?? null,
      date: opensAt,
      status: EventStatus.SCHEDULED,
      opensAt,
      closesAt,
      openedAt: opensAt,
    },
  });
}

/** Open for check-in right now. */
export async function makeOpenEvent(orgId: string, categoryId: string) {
  const now = Date.now();
  return prisma.event.create({
    data: {
      orgId,
      slug: `open-${randomUUID()}`,
      name: "Open Event",
      categoryId,
      date: new Date(now),
      status: EventStatus.SCHEDULED,
      opensAt: new Date(now - 10 * 60 * 1000),
      closesAt: new Date(now + 60 * 60 * 1000),
      openedAt: new Date(now - 10 * 60 * 1000),
    },
  });
}

export async function checkIn(userId: string, eventId: string, role: Role = Role.GENERAL, answers: Record<string, string> = {}) {
  return prisma.registration.create({
    data: {
      eventId,
      userId,
      pointsAwarded: role === Role.GENERAL ? 2 : 0,
      roleAtTime: role,
      answers: { create: Object.entries(answers).map(([fieldKey, value]) => ({ fieldKey, value })) },
    },
  });
}

export async function makeGroup(
  orgId: string,
  tiers: Array<{ min: number; max: number | null; bonus: number }>,
  options: { finalized?: boolean; expectedEventCount?: number } = {},
) {
  return prisma.eventGroup.create({
    data: {
      orgId,
      name: "NSBE Week",
      slug: `nsbe-week-${randomUUID()}`,
      kind: GroupKind.NSBE_WEEK,
      expectedEventCount: options.expectedEventCount ?? 5,
      bonusTiers: tiers,
      finalizedAt: options.finalized ? new Date(Date.now() - 60 * 60 * 1000) : null,
    },
  });
}

export async function makeGameBonus(orgId: string, userId: string, eventId: string, points = 1) {
  return prisma.pointAward.create({
    data: { orgId, userId, eventId, kind: AwardKind.GAME_COMPETITION, points, reason: "Won the game" },
  });
}

/** "2026-09" for a Date, bucketed in local time exactly like lib/points.ts monthKeyOf. */
export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
