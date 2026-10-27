/**
 * House Points end to end against the real Postgres at DATABASE_URL: the
 * unique constraints, the roster rules as SQL actually applies them, the
 * trash, corrections, seasons — and the proof that running House scoring
 * leaves the member track and the E-Board track exactly where they were.
 *
 * Every test gets its own Org (see test/db-fixtures.ts): a House roster is
 * org-wide, so two tests sharing one would count each other's members.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HouseCategory, Role } from "@/generated/prisma/enums";
import { checkIn, createTestOrg, makeClosedEvent, makeMember, TEST_SEASON, type TestOrg } from "@/test/db-fixtures";
import {
  calculateHouseMonth,
  createManualHouseAward,
  getHouseBoard,
  getHouseEventStats,
  getHouseMembership,
  getHouseMonthlyStandings,
  getHousePointsHistory,
  getHouseSeasons,
  getHouseMonthsNeedingRecalculation,
  processEventHouseScoring,
  recalculateAllHouseScoring,
  revokeHouseAward,
  runHouseScoringSweep,
  setCompetitionWinners,
} from "./house-repo";
import { prisma } from "./prisma";
import {
  addManualAttendance,
  getEboardBoardRows,
  getEboardStandings,
  getMemberBreakdown,
  getStandings,
  removeRegistration,
  restoreEvent,
  trashEvent,
  trashMember,
  updateEvent,
} from "./repo";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

const ACTOR = "house-admin@bison.howard.edu";
const SHOW_AND_REP = { countsForShowUp: true, countsForRepYourHouse: true };

let org: TestOrg;
let orgId: string;

beforeEach(async () => {
  org = await createTestOrg("houses");
  orgId = org.orgId;
  const admin = await makeMember(orgId, { role: Role.ADMIN });
  await prisma.user.update({ where: { id: admin.id }, data: { email: ACTOR } });
});

afterEach(async () => {
  await org.cleanup();
});

/** A GENERAL member (unless `role` says otherwise) with a House, verified unless told not to be. */
async function houseMember(house: string | null, opts: { verified?: boolean; role?: Role } = {}) {
  const u = await makeMember(orgId, { role: opts.role });
  return prisma.user.update({
    where: { id: u.id },
    data: { house, houseVerifiedAt: house && opts.verified !== false ? new Date() : null },
  });
}

async function houseEvent(flags: Record<string, boolean>, closesAt?: Date) {
  const e = await makeClosedEvent(orgId, org.gbmCategoryId, closesAt ? { closesAt } : {});
  return prisma.event.update({ where: { id: e.id }, data: flags });
}

async function rows(eventId: string) {
  return prisma.housePointAward.findMany({ where: { orgId, eventId }, orderBy: [{ house: "asc" }, { category: "asc" }] });
}

const pointsBy = (rs: Array<{ house: string; category: string; points: number }>, category: string) =>
  Object.fromEntries(rs.filter((r) => r.category === category).map((r) => [r.house, r.points]));

/** 4 Jemison, 2 Latimer, 1 Dean, 0 Johnson — the default roster for most tests. */
async function standardRoster() {
  const jemison = await Promise.all([0, 1, 2, 3].map(() => houseMember("Jemison")));
  const latimer = await Promise.all([0, 1].map(() => houseMember("Latimer")));
  const dean = [await houseMember("Dean")];
  return { jemison, latimer, dean };
}

describe("event scoring", () => {
  it("processing the same event twice produces one award per House per category", async () => {
    const { jemison, latimer, dean } = await standardRoster();
    const event = await houseEvent(SHOW_AND_REP);
    for (const u of [...jemison.slice(0, 3), latimer[0]]) await checkIn(u.id, event.id);

    const first = await processEventHouseScoring(orgId, event.id, { actor: ACTOR });
    const second = await processEventHouseScoring(orgId, event.id, { actor: ACTOR });
    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);

    const rs = await rows(event.id);
    // Jemison 3/4 = 75% → 2; Latimer 1/2 = 50% → 1; Dean 0/1 → 0; Johnson has nobody → no row.
    expect(pointsBy(rs, "SHOW_UP")).toEqual({ JEMISON: 2, LATIMER: 1, DEAN: 0 });
    expect(pointsBy(rs, "REP_YOUR_HOUSE")).toEqual({ JEMISON: 1, LATIMER: 0, DEAN: 0 });
    expect(rs).toHaveLength(6);
    const jem = rs.find((r) => r.house === "JEMISON" && r.category === "SHOW_UP")!;
    expect(jem).toMatchObject({ attendeeCount: 3, rosterCount: 4, awardedById: null });
    expect(Number(jem.percentage)).toBe(75);
    expect(jem.attendeeIds).toEqual(jemison.slice(0, 3).map((u) => u.id).sort());
    expect((await prisma.event.findUnique({ where: { id: event.id } }))!.houseScoredAt).not.toBeNull();
    void dean;
  });

  it("the unique constraint itself refuses a second row — not just the application", async () => {
    await standardRoster();
    const event = await houseEvent(SHOW_AND_REP);
    await processEventHouseScoring(orgId, event.id);
    await expect(
      prisma.housePointAward.create({
        data: { orgId, season: TEST_SEASON, house: "JEMISON", category: HouseCategory.SHOW_UP, points: 2, eventId: event.id, reason: "dup" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // And an event-scoped category without an eventId (which would dodge the index) is a CHECK violation.
    await expect(
      prisma.housePointAward.create({
        data: { orgId, season: TEST_SEASON, house: "JEMISON", category: HouseCategory.SHOW_UP, points: 2, reason: "no event" },
      }),
    ).rejects.toThrow();
  });

  it("members with no House, an unverified House, officers, guests and trashed members are out of both numerator and denominator", async () => {
    const counted = [await houseMember("Latimer"), await houseMember("Latimer")];
    const noHouse = await houseMember(null);
    const unverified = await houseMember("Latimer", { verified: false });
    const officer = await houseMember("Latimer", { role: Role.EBOARD });
    const guest = await houseMember("Latimer", { role: Role.GUEST });
    const trashed = await houseMember("Latimer");
    const event = await houseEvent({ countsForShowUp: true });
    for (const u of [counted[0], noHouse, unverified, officer, trashed]) await checkIn(u.id, event.id);
    await checkIn(guest.id, event.id, Role.GUEST);
    await trashMember(orgId, trashed.email, "Duplicate account", ACTOR);

    await processEventHouseScoring(orgId, event.id);
    const latimer = (await rows(event.id)).find((r) => r.house === "LATIMER")!;
    expect(latimer).toMatchObject({ attendeeCount: 1, rosterCount: 2, points: 1 });
    expect(latimer.attendeeIds).toEqual([counted[0].id]);
  });

  it("refuses to score an event that hasn't closed", async () => {
    const e = await prisma.event.create({
      data: {
        orgId,
        slug: `open-${Date.now()}`,
        name: "Open",
        categoryId: org.gbmCategoryId,
        date: new Date(),
        status: "SCHEDULED",
        opensAt: new Date(Date.now() - 60_000),
        closesAt: new Date(Date.now() + 3_600_000),
        countsForShowUp: true,
      },
    });
    await expect(processEventHouseScoring(orgId, e.id)).rejects.toThrow(/closed/);
  });

  it("WIN awards 1 point per selected winner, recorded with the admin who picked them", async () => {
    await standardRoster();
    const event = await houseEvent({ isHouseCompetition: true });
    await setCompetitionWinners(orgId, event.id, ["DEAN", "LATIMER"], ACTOR);
    const admin = await prisma.user.findFirstOrThrow({ where: { orgId, email: ACTOR } });
    let rs = await rows(event.id);
    expect(pointsBy(rs, "WIN")).toEqual({ DEAN: 1, LATIMER: 1 });
    expect(rs.every((r) => r.awardedById === admin.id)).toBe(true);

    // Changing the pick zeroes the dropped House rather than deleting its row.
    await setCompetitionWinners(orgId, event.id, ["DEAN"], ACTOR);
    rs = await rows(event.id);
    expect(pointsBy(rs, "WIN")).toEqual({ DEAN: 1, LATIMER: 0 });
  });

  it("the lazy sweep scores a due event on its own, and is rate-limited", async () => {
    await standardRoster();
    const event = await houseEvent(SHOW_AND_REP);
    const r = await runHouseScoringSweep(orgId);
    expect(r).toMatchObject({ ran: true, eventsScored: 1 });
    expect(await rows(event.id)).not.toHaveLength(0);
    expect(await runHouseScoringSweep(orgId)).toEqual({ ran: false, reason: "rate_limited" });
  });
});

describe("corrections", () => {
  it("correcting attendance recalculates that event's House points, keeping the original snapshot", async () => {
    const { jemison } = await standardRoster();
    const event = await houseEvent(SHOW_AND_REP);
    const reg = await checkIn(jemison[0].id, event.id);
    await processEventHouseScoring(orgId, event.id);
    expect(pointsBy(await rows(event.id), "SHOW_UP").JEMISON).toBe(0); // 1/4 = 25%

    await addManualAttendance({ orgId, eventId: event.id, email: jemison[1].email, note: "Signed the paper sheet", addedBy: ACTOR });
    let jem = (await rows(event.id)).find((r) => r.house === "JEMISON" && r.category === "SHOW_UP")!;
    expect(jem).toMatchObject({ points: 1, attendeeCount: 2, rosterCount: 4 }); // 2/4 = 50%
    expect(jem.originalSnapshot).toMatchObject({ points: 0, attendeeCount: 1, rosterCount: 4, percentage: 25 });
    expect(jem.recalculatedAt).not.toBeNull();

    await removeRegistration(orgId, reg.id, "Checked in by mistake", ACTOR);
    jem = (await rows(event.id)).find((r) => r.house === "JEMISON" && r.category === "SHOW_UP")!;
    expect(jem).toMatchObject({ points: 0, attendeeCount: 1 });
    // The FIRST values are kept, not overwritten by the intermediate ones.
    expect(jem.originalSnapshot).toMatchObject({ attendeeCount: 1, percentage: 25 });
    expect((await prisma.event.findUnique({ where: { id: event.id } }))!.houseScoringStale).toBe(false);
  });

  it("an admin's revoke survives recalculation", async () => {
    const { jemison } = await standardRoster();
    const event = await houseEvent(SHOW_AND_REP);
    for (const u of jemison) await checkIn(u.id, event.id);
    await processEventHouseScoring(orgId, event.id);
    const row = (await rows(event.id)).find((r) => r.house === "JEMISON" && r.category === "SHOW_UP")!;
    await revokeHouseAward(orgId, row.id, "Scored against the wrong event", ACTOR);
    await recalculateAllHouseScoring(orgId, ACTOR);
    expect((await prisma.housePointAward.findUnique({ where: { id: row.id } }))!.revokedAt).not.toBeNull();
    const board = await getHouseBoard(orgId);
    expect(board.totals.find((t) => t.house === "JEMISON")!.byCategory.SHOW_UP).toBe(0);
  });

  it("editing a House flag after scoring marks the event due again", async () => {
    await standardRoster();
    const event = await houseEvent({ countsForShowUp: true });
    await processEventHouseScoring(orgId, event.id);
    await updateEvent({
      orgId,
      eventId: event.id,
      house: { countsForShowUp: false, countsForRepYourHouse: true, countsForMonthlyHouse: false, isHouseCompetition: false },
      actor: ACTOR,
    });
    expect((await prisma.event.findUnique({ where: { id: event.id } }))!.houseScoringStale).toBe(true);
    await processEventHouseScoring(orgId, event.id);
    const rs = await rows(event.id);
    expect(Object.values(pointsBy(rs, "SHOW_UP")).every((p) => p === 0)).toBe(true);
    expect(rs.some((r) => r.category === "REP_YOUR_HOUSE")).toBe(true);
  });
});

describe("Own the Month", () => {
  const sept = (day: number) => new Date(2026, 8, day, 19, 0);

  it("averages each House's percentage across the month's events, and a calculated month is never recalculated automatically", async () => {
    const { jemison, latimer } = await standardRoster();
    const a = await houseEvent({ countsForMonthlyHouse: true }, sept(10));
    const b = await houseEvent({ countsForMonthlyHouse: true }, sept(20));
    // Jemison: 4/4 and 0/4 → 50%. Latimer: 1/2 and 1/2 → 50%. Dean: 0 and 0. A tie at the top.
    for (const u of jemison) await checkIn(u.id, a.id);
    await checkIn(latimer[0].id, a.id);
    await checkIn(latimer[1].id, b.id);

    await expect(calculateHouseMonth(orgId, "2026-10", ACTOR)).rejects.toThrow(/isn't over/);
    const first = await calculateHouseMonth(orgId, "2026-09", ACTOR);
    expect(first.winners.sort()).toEqual(["JEMISON", "LATIMER"]);
    const monthRows = await prisma.housePointAward.findMany({ where: { orgId, periodMonth: "2026-09" } });
    expect(Object.fromEntries(monthRows.map((r) => [r.house, r.points]))).toEqual({ JEMISON: 2, LATIMER: 2, DEAN: 0 });
    expect((await calculateHouseMonth(orgId, "2026-09", ACTOR)).unchanged).toBe(true);

    // A late correction in September flags the month — the sweep does NOT recalculate it.
    await addManualAttendance({ orgId, eventId: b.id, email: jemison[0].email, note: "Late paper sheet", addedBy: ACTOR });
    expect((await getHouseMonthsNeedingRecalculation(orgId)).map((m) => m.month)).toEqual(["2026-09"]);
    await runHouseScoringSweep(orgId, { force: true });
    const after = await prisma.housePointAward.findMany({ where: { orgId, periodMonth: "2026-09" } });
    expect(Object.fromEntries(after.map((r) => [r.house, r.points]))).toEqual({ JEMISON: 2, LATIMER: 2, DEAN: 0 });

    // An explicit recalculation applies it (Jemison 4/4 + 1/4 = 62.5% beats 50%) and clears the flag.
    const recalculated = await calculateHouseMonth(orgId, "2026-09", ACTOR);
    expect(recalculated.winners).toEqual(["JEMISON"]);
    expect(await getHouseMonthsNeedingRecalculation(orgId)).toEqual([]);
  });

  it("the sweep calculates a finished month that was never calculated", async () => {
    const { jemison } = await standardRoster();
    const a = await houseEvent({ countsForMonthlyHouse: true }, sept(12));
    await checkIn(jemison[0].id, a.id);
    const r = await runHouseScoringSweep(orgId);
    expect(r).toMatchObject({ ran: true, monthsCalculated: ["2026-09"] });
  });
});

describe("the trash", () => {
  it("deleting an event removes its House awards from every total and flags affected months; restoring restores them exactly", async () => {
    const { jemison } = await standardRoster();
    const event = await houseEvent({ ...SHOW_AND_REP, countsForMonthlyHouse: true }, new Date(2026, 8, 15, 19));
    for (const u of jemison) await checkIn(u.id, event.id);
    await processEventHouseScoring(orgId, event.id);
    await calculateHouseMonth(orgId, "2026-09", ACTOR);
    const before = await getHouseBoard(orgId);
    const rowsBefore = await prisma.housePointAward.findMany({ where: { orgId }, orderBy: { id: "asc" } });
    expect(before.totals.find((t) => t.house === "JEMISON")!.total).toBe(2 + 1 + 2);

    await trashEvent(orgId, event.id, "Duplicate of the real GBM", ACTOR);
    const during = await getHouseBoard(orgId);
    // The event's own awards are gone from the total. The month award was
    // materialized and stays until an admin recalculates — flagged:
    expect(during.totals.find((t) => t.house === "JEMISON")!.byCategory).toMatchObject({ SHOW_UP: 0, REP_YOUR_HOUSE: 0, OWN_THE_MONTH: 2 });
    const flagged = await getHouseMonthsNeedingRecalculation(orgId);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ month: "2026-09", events: [{ eventId: event.id, why: "trashed" }] });

    await restoreEvent(orgId, event.id, ACTOR);
    const restored = await getHouseBoard(orgId);
    expect(restored.totals).toEqual(before.totals);
    const rowsAfter = await prisma.housePointAward.findMany({ where: { orgId }, orderBy: { id: "asc" } });
    expect(rowsAfter).toEqual(rowsBefore);
  });
});

describe("seasons", () => {
  it("House awards are season-scoped and do not survive rollover — and nothing is deleted", async () => {
    const { jemison } = await standardRoster();
    const event = await houseEvent(SHOW_AND_REP);
    for (const u of jemison) await checkIn(u.id, event.id);
    await processEventHouseScoring(orgId, event.id);
    await createManualHouseAward({ orgId, house: "DEAN", points: 3, reason: "Community service drive", actor: ACTOR });
    const count = await prisma.housePointAward.count({ where: { orgId } });
    expect((await getHouseBoard(orgId)).totals.some((t) => t.total > 0)).toBe(true);

    await prisma.config.update({ where: { orgId_key: { orgId, key: "SEASON" } }, data: { value: "2027-2028" } });
    const next = await getHouseBoard(orgId);
    expect(next.season).toBe("2027-2028");
    expect(next.totals.every((t) => t.total === 0)).toBe(true);
    // The prior season is still there, intact.
    const prior = await getHouseBoard(orgId, TEST_SEASON);
    expect(prior.totals.find((t) => t.house === "JEMISON")!.total).toBe(3);
    expect(prior.totals.find((t) => t.house === "DEAN")!.total).toBe(3);
    expect(await prisma.housePointAward.count({ where: { orgId } })).toBe(count);
  });
});

describe("manual awards", () => {
  it("allows negative points, requires a 10-character reason, and refuses zero", async () => {
    await createManualHouseAward({ orgId, house: "LATIMER", points: -2, reason: "Left the room a mess", actor: ACTOR });
    await expect(createManualHouseAward({ orgId, house: "LATIMER", points: 1, reason: "too short", actor: ACTOR })).rejects.toThrow(/10/);
    await expect(createManualHouseAward({ orgId, house: "LATIMER", points: 0, reason: "Nothing at all here", actor: ACTOR })).rejects.toThrow();
    const board = await getHouseBoard(orgId);
    expect(board.totals.find((t) => t.house === "LATIMER")!.total).toBe(-2);
    const row = await prisma.housePointAward.findFirstOrThrow({ where: { orgId, category: HouseCategory.MANUAL } });
    expect(row.awardedById).not.toBeNull();
  });
});

describe("the member and E-Board tracks are untouched", () => {
  it("a member's individual points and the E-Board internal board are unchanged by any House scoring", async () => {
    const { jemison, latimer } = await standardRoster();
    const officer = await houseMember("Jemison", { role: Role.EBOARD });
    const event = await houseEvent({ ...SHOW_AND_REP, countsForMonthlyHouse: true, isHouseCompetition: true }, new Date(2026, 8, 18, 19));
    for (const u of [...jemison, latimer[0]]) await checkIn(u.id, event.id);
    await checkIn(officer.id, event.id, Role.EBOARD);
    const members = [...jemison, ...latimer, officer];

    const snapshot = async () => ({
      breakdowns: await Promise.all(members.map((m) => getMemberBreakdown(orgId, m.email))),
      standings: await getStandings(orgId),
      eboard: await getEboardStandings(orgId),
      eboardBoard: await getEboardBoardRows(orgId),
      registrations: await prisma.registration.findMany({ where: { event: { orgId } }, orderBy: { id: "asc" } }),
      pointAwards: await prisma.pointAward.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
      users: await prisma.user.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    });
    const before = await snapshot();
    expect(before.breakdowns[0].total).toBeGreaterThan(0);

    await processEventHouseScoring(orgId, event.id, { actor: ACTOR });
    await setCompetitionWinners(orgId, event.id, ["JEMISON"], ACTOR);
    await calculateHouseMonth(orgId, "2026-09", ACTOR);
    await createManualHouseAward({ orgId, house: "JEMISON", points: 5, reason: "Won the step show", actor: ACTOR });
    await recalculateAllHouseScoring(orgId, ACTOR);
    await runHouseScoringSweep(orgId, { force: true });
    expect((await getHouseBoard(orgId)).totals[0].total).toBeGreaterThan(0);

    expect(await snapshot()).toEqual(before);
  });
});

describe("the /admin/houses reads", () => {
  it("load together for a season with scored events, a calculated month and a competition", async () => {
    const { jemison } = await standardRoster();
    await houseMember("Dean", { verified: false });
    const e = await houseEvent({ ...SHOW_AND_REP, countsForMonthlyHouse: true, isHouseCompetition: true }, new Date(2026, 8, 18, 19));
    await checkIn(jemison[0].id, e.id);
    await processEventHouseScoring(orgId, e.id);
    await calculateHouseMonth(orgId, "2026-09", ACTOR);

    const [history, membership, stats, monthly, seasons] = await Promise.all([
      getHousePointsHistory(orgId, TEST_SEASON),
      getHouseMembership(orgId, TEST_SEASON),
      getHouseEventStats(orgId, TEST_SEASON),
      getHouseMonthlyStandings(orgId, TEST_SEASON),
      getHouseSeasons(orgId),
    ]);
    expect(history.length).toBeGreaterThan(0);
    expect(history.find((r) => r.category === "OWN_THE_MONTH")!.periodMonth).toBe("2026-09");
    const jem = membership.houses.find((h) => h.house === "JEMISON")!;
    expect(jem.members).toHaveLength(4);
    expect(jem.members.find((m) => m.id === jemison[0].id)!.attended).toBe(1);
    expect(membership.houses.find((h) => h.house === "DEAN")!.pendingCount).toBe(1);
    expect(stats.find((s) => s.eventId === e.id)!.perHouse.JEMISON).toEqual({ attendeeCount: 1, rosterCount: 4, percentage: 25 });
    expect(monthly.past.find((m) => m.month === "2026-09")!.winners).toEqual(["JEMISON"]);
    expect(monthly.current.provisional).toBe(true);
    expect(seasons).toEqual([TEST_SEASON]);
  });
});
