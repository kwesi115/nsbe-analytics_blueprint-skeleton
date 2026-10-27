/**
 * House Points — the database half (the rules live in lib/house-scoring.ts).
 *
 * A sibling of lib/repo.ts rather than more of it: the same conventions (orgId
 * first, domain types out, the trash filter spelled out at each query, every
 * write logged to AdminLog in its own transaction), but House scoring is a
 * separate track and keeping it in its own file makes "nothing here touches
 * the member or E-Board tracks" checkable by reading one file. It never writes
 * Registration, PointAward or User — only HousePointAward and the Event
 * columns that belong to House scoring.
 *
 * lib/repo.ts calls in here (attendance corrections, trash, restore); nothing
 * here imports lib/repo.ts, so there is no cycle.
 *
 * Roster snapshots: the app keeps no House assignment history, so "the roster
 * as of the event date" cannot be reconstructed for the past. Instead every
 * automatic award row records the roster count, attendee count, percentage and
 * the attending member ids AT THE MOMENT SCORING RAN. Recalculating uses the
 * CURRENT roster — and moves the row's first values into originalSnapshot, so
 * what an award originally said is never lost.
 */

import { Prisma } from "@/generated/prisma/client";
import {
  EventStatus as DbEventStatus,
  House as DbHouse,
  HouseCategory as DbHouseCategory,
  Role as DbRole,
  UserStatus as DbUserStatus,
} from "@/generated/prisma/enums";
import { normalizeEmail } from "./email";
import { AppError } from "./errors";
import { formatMonthKey, memberDisplayName } from "./format";
import {
  EVENT_CATEGORIES,
  HOUSE_CODES,
  OWN_THE_MONTH_POINTS,
  buildRoster,
  desiredEventAwards,
  houseTotals,
  monthlyAverages,
  ownTheMonthWinners,
  percentageOrNull,
  tallyEvent,
  type EventHouseCategory,
  type EventTally,
  type HouseCategoryCode,
  type HouseCode,
  type HouseRoster,
  type HouseTotal,
} from "./house-scoring";
import { codeFromName, DEFAULT_HOUSES, parseHouses } from "./houses";
import { isMonthOver, monthKeyOf } from "./points";
import { prisma } from "./prisma";
import { seasonOf, seasonRange } from "./season";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const HOUSE_MANUAL_REASON_MIN_LENGTH = 10;
export const HOUSE_MANUAL_MAX_ABS = 100;

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

async function currentSeason(db: Db, orgId: string): Promise<string> {
  const row = await db.config.findUnique({ where: { orgId_key: { orgId, key: "SEASON" } } });
  return row?.value ?? "";
}

/** A User id for an acting admin's email, or null for "system"/"cron" and anyone not on the roster. */
async function actorUserId(db: Db, orgId: string, actor: string): Promise<string | null> {
  if (!actor.includes("@")) return null;
  const u = await db.user.findUnique({ where: { orgId_email: { orgId, email: normalizeEmail(actor) } }, select: { id: true } });
  return u?.id ?? null;
}

async function log(db: Db, orgId: string, entry: { actor: string; action: string; target: string; detail?: string }) {
  await db.adminLog.create({
    data: {
      orgId,
      actorId: await actorUserId(db, orgId, entry.actor),
      action: entry.action,
      target: entry.target,
      detail: entry.detail ?? null,
    },
  });
}

function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/** Whether any House flag is set — an event with none never touches this track. */
export function hasHouseFlags(e: {
  countsForShowUp: boolean;
  countsForRepYourHouse: boolean;
  countsForMonthlyHouse: boolean;
  isHouseCompetition: boolean;
}): boolean {
  return e.countsForShowUp || e.countsForRepYourHouse || e.countsForMonthlyHouse || e.isHouseCompetition;
}

function isClosed(e: { status: DbEventStatus; closesAt: Date | null }, now: Date): boolean {
  return e.status === DbEventStatus.SCHEDULED && e.closesAt !== null && e.closesAt.getTime() <= now.getTime();
}

/** The season an event's awards belong to — its own date's, never the season it happened to be scored in. */
function eventSeason(e: { closesAt: Date | null; date: Date }): string {
  return seasonOf(e.closesAt ?? e.date);
}

// ---------------------------------------------------------------------------
// Roster and attendance
// ---------------------------------------------------------------------------

/**
 * Every member who counts toward a House right now. The SQL narrows the read;
 * lib/house-scoring.ts houseForRoster is the rule, applied to what comes back,
 * so the two can't disagree about who is in.
 */
export async function loadHouseRoster(db: Db, orgId: string): Promise<HouseRoster> {
  const users = await db.user.findMany({
    where: { orgId, role: DbRole.GENERAL, deletedAt: null, houseVerifiedAt: { not: null }, house: { not: null } },
    select: { id: true, house: true, houseVerifiedAt: true, deletedAt: true, status: true },
  });
  return buildRoster(
    users.map((u) => ({
      id: u.id,
      house: u.house,
      houseVerifiedAt: u.houseVerifiedAt,
      role: "general" as const,
      deletedAt: u.deletedAt,
      suspended: u.status === DbUserStatus.SUSPENDED,
    })),
  );
}

/** The registrations behind a set of events, by event. GUEST registrations are dropped here as well as by the roster. */
async function attendeesByEvent(db: Db, eventIds: string[]): Promise<Map<string, string[]>> {
  const rows = await db.registration.findMany({
    where: { eventId: { in: eventIds }, roleAtTime: { not: DbRole.GUEST } },
    select: { eventId: true, userId: true },
  });
  const out = new Map<string, string[]>(eventIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.eventId)!.push(r.userId);
  return out;
}

// ---------------------------------------------------------------------------
// Writing rows — shared by event and month scoring
// ---------------------------------------------------------------------------

interface DesiredRow {
  house: HouseCode;
  category: HouseCategoryCode;
  points: number;
  attendeeCount: number | null;
  rosterCount: number | null;
  percentage: number | null;
  attendeeIds: string[];
  reason: string;
  inputs: unknown;
  awardedById: string | null;
}

export interface HouseAwardChange {
  house: HouseCode;
  category: HouseCategoryCode;
  /** null when the row is new. */
  from: number | null;
  to: number;
  fromPercentage: number | null;
  toPercentage: number | null;
}

type ExistingRow = Prisma.HousePointAwardGetPayload<object>;

function decimalToNumber(d: Prisma.Decimal | null): number | null {
  return d === null ? null : Number(d.toString());
}

function snapshotOf(row: ExistingRow) {
  return {
    points: row.points,
    attendeeCount: row.attendeeCount,
    rosterCount: row.rosterCount,
    percentage: decimalToNumber(row.percentage),
    attendeeIds: row.attendeeIds,
    reason: row.reason,
    awardedAt: row.awardedAt.toISOString(),
  };
}

function sameNumbers(row: ExistingRow, d: DesiredRow): boolean {
  return (
    row.points === d.points &&
    row.attendeeCount === d.attendeeCount &&
    row.rosterCount === d.rosterCount &&
    decimalToNumber(row.percentage) === d.percentage &&
    row.attendeeIds.join(",") === d.attendeeIds.join(",") &&
    row.reason === d.reason
  );
}

/**
 * Brings the existing rows for one event (or one month) in line with
 * `desired`. Creates what's missing, UPDATES what changed — keeping the first
 * values in originalSnapshot — and zeroes a row whose House no longer
 * qualifies at all. Never deletes a row and never touches revokedAt: an admin's
 * revoke survives every recalculation.
 *
 * The @@unique constraints are the backstop: two concurrent runs both see "no
 * row" and both create, and the second fails with P2002 rather than writing a
 * duplicate — see withUniqueRetry.
 */
async function syncRows(
  tx: Tx,
  scope: { orgId: string; season: string; eventId: string | null; periodMonth: string | null },
  existing: ExistingRow[],
  desired: DesiredRow[],
  orphanReason: (row: ExistingRow) => string,
  now: Date,
): Promise<HouseAwardChange[]> {
  const changes: HouseAwardChange[] = [];
  const key = (house: string, category: string) => `${house}:${category}`;
  const byKey = new Map(existing.map((r) => [key(r.house, r.category), r]));
  const desiredKeys = new Set(desired.map((d) => key(d.house, d.category)));

  for (const d of desired) {
    const row = byKey.get(key(d.house, d.category));
    const data = {
      points: d.points,
      attendeeCount: d.attendeeCount,
      rosterCount: d.rosterCount,
      percentage: d.percentage,
      attendeeIds: d.attendeeIds,
      reason: d.reason,
      inputs: (d.inputs ?? Prisma.DbNull) as Prisma.InputJsonValue,
    };
    if (!row) {
      await tx.housePointAward.create({
        data: {
          ...data,
          orgId: scope.orgId,
          season: scope.season,
          house: d.house as DbHouse,
          category: d.category as DbHouseCategory,
          eventId: scope.eventId,
          periodMonth: scope.periodMonth,
          awardedById: d.awardedById,
          awardedAt: now,
        },
      });
      changes.push({ house: d.house, category: d.category, from: null, to: d.points, fromPercentage: null, toPercentage: d.percentage });
      continue;
    }
    if (sameNumbers(row, d)) continue;
    await tx.housePointAward.update({
      where: { id: row.id },
      data: {
        ...data,
        originalSnapshot: (row.originalSnapshot ?? snapshotOf(row)) as Prisma.InputJsonValue,
        recalculatedAt: now,
      },
    });
    changes.push({
      house: d.house,
      category: d.category,
      from: row.points,
      to: d.points,
      fromPercentage: decimalToNumber(row.percentage),
      toPercentage: d.percentage,
    });
  }

  for (const row of existing) {
    if (desiredKeys.has(key(row.house, row.category))) continue;
    if (row.points === 0) continue;
    await tx.housePointAward.update({
      where: { id: row.id },
      data: {
        points: 0,
        reason: orphanReason(row),
        originalSnapshot: (row.originalSnapshot ?? snapshotOf(row)) as Prisma.InputJsonValue,
        recalculatedAt: now,
      },
    });
    changes.push({
      house: row.house as HouseCode,
      category: row.category as HouseCategoryCode,
      from: row.points,
      to: 0,
      fromPercentage: decimalToNumber(row.percentage),
      toPercentage: decimalToNumber(row.percentage),
    });
  }
  return changes;
}

/** Runs `work` again once if it lost a create race on a House award's unique index — the retry sees the winner's row and updates it instead. */
async function withUniqueRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return work();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Event scoring
// ---------------------------------------------------------------------------

export interface ProcessEventResult {
  eventId: string;
  eventName: string;
  changes: HouseAwardChange[];
  unchanged: boolean;
}

const ORPHAN_REASON: Record<EventHouseCategory, string> = {
  SHOW_UP: "Show Up — no longer scored (flag removed or no members assigned)",
  REP_YOUR_HOUSE: "Rep Your House — no longer scored (flag removed or no members assigned)",
  WIN: "Win — no longer a selected winner",
};

/**
 * Scores one closed event for SHOW_UP, REP_YOUR_HOUSE and WIN — whichever
 * flags are set — against the CURRENT roster, and records houseScoredAt.
 * Idempotent: running it twice in a row writes nothing the second time, and
 * the unique constraints make a second row per House per category impossible
 * whatever the application does.
 *
 * `only` narrows it to some categories — selecting competition winners syncs
 * WIN without re-snapshotting everyone's attendance.
 */
export async function processEventHouseScoring(
  orgId: string,
  eventId: string,
  options: { actor?: string; now?: Date; only?: readonly EventHouseCategory[]; trigger?: string } = {},
): Promise<ProcessEventResult> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? "system";
  const only = options.only ?? EVENT_CATEGORIES;
  const fullRun = only.length === EVENT_CATEGORIES.length;

  return withUniqueRetry(() =>
    prisma.$transaction(async (tx) => {
      const event = await tx.event.findFirst({ where: { id: eventId, orgId, deletedAt: null } });
      if (!event) throw new AppError("NOT_FOUND", "Event not found");
      if (!isClosed(event, now)) {
        throw new AppError("VALIDATION_FAILED", "House scoring runs once the event's check-in window has closed.");
      }

      const roster = await loadHouseRoster(tx, orgId);
      const attendees = (await attendeesByEvent(tx, [eventId])).get(eventId)!;
      const tally = tallyEvent(roster, attendees);
      const desired: DesiredRow[] = desiredEventAwards(
        {
          countsForShowUp: event.countsForShowUp,
          countsForRepYourHouse: event.countsForRepYourHouse,
          isHouseCompetition: event.isHouseCompetition,
          competitionWinners: event.competitionWinners as HouseCode[],
        },
        tally,
        only,
      ).map((d) => ({ ...d, awardedById: d.category === "WIN" ? event.competitionWinnersById : null }));

      const existing = await tx.housePointAward.findMany({
        where: { orgId, eventId, category: { in: only as DbHouseCategory[] } },
      });
      const changes = await syncRows(
        tx,
        { orgId, season: eventSeason(event), eventId, periodMonth: null },
        existing,
        desired,
        (row) => ORPHAN_REASON[row.category as EventHouseCategory],
        now,
      );

      if (fullRun) {
        await tx.event.update({ where: { id: eventId }, data: { houseScoredAt: now, houseScoringStale: false } });
      }
      await log(tx, orgId, {
        actor,
        action: "house_score_event",
        target: eventId,
        detail:
          `${event.name}${options.trigger ? ` (${options.trigger})` : ""} — ` +
          (changes.length === 0
            ? "no change"
            : changes.map((c) => `${c.house} ${c.category} ${c.from ?? "new"}→${c.to}`).join(", ")),
      });
      return { eventId, eventName: event.name, changes, unchanged: changes.length === 0 };
    }),
  );
}

/**
 * Called by lib/repo.ts after a registration is added to or removed from an
 * event — the correction path. Marks the event's House numbers changed (which
 * flags a calculated month containing it) and, if the event was already
 * scored, recomputes that event's House awards right away. A failure here
 * never undoes the attendance change: the event stays marked stale and the
 * lazy sweep recomputes it.
 */
export async function onHouseAttendanceChanged(orgId: string, eventId: string): Promise<void> {
  const event = await prisma.event.findFirst({ where: { id: eventId, orgId } });
  if (!event || !hasHouseFlags(event)) return;
  const now = new Date();
  await prisma.event.update({
    where: { id: eventId },
    data: { houseChangedAt: now, houseScoringStale: event.houseScoredAt !== null },
  });
  if (event.houseScoredAt === null || event.deletedAt !== null || !isClosed(event, now)) return;
  try {
    await processEventHouseScoring(orgId, eventId, { now, trigger: "attendance correction" });
  } catch (err) {
    console.error("[houses] recompute after attendance change failed", { eventId, err });
  }
}

/**
 * Admin picks the winning House(s) of a closed competition. Writes the choice
 * onto the event and syncs the WIN rows only — 1 point per winner, awardedBy
 * the admin. Choosing none clears every WIN for the event (rows go to 0).
 */
export async function setCompetitionWinners(
  orgId: string,
  eventId: string,
  winners: string[],
  actor: string,
  now: Date = new Date(),
): Promise<ProcessEventResult> {
  const valid = [...new Set(winners)].filter((w): w is HouseCode => (HOUSE_CODES as readonly string[]).includes(w));
  if (valid.length !== new Set(winners).size) throw new AppError("VALIDATION_FAILED", "Unknown House.");
  const event = await prisma.event.findFirst({ where: { id: eventId, orgId, deletedAt: null } });
  if (!event) throw new AppError("NOT_FOUND", "Event not found");
  if (!event.isHouseCompetition) throw new AppError("VALIDATION_FAILED", "This event isn't marked as a House competition.");
  if (!isClosed(event, now)) throw new AppError("VALIDATION_FAILED", "Winners can be chosen once the event has closed.");
  await prisma.event.update({
    where: { id: eventId },
    data: { competitionWinners: valid as DbHouse[], competitionWinnersById: await actorUserId(prisma, orgId, actor) },
  });
  return processEventHouseScoring(orgId, eventId, { actor, now, only: ["WIN"], trigger: "winners selected" });
}

// ---------------------------------------------------------------------------
// Own the Month
// ---------------------------------------------------------------------------

export interface MonthEventRow {
  eventId: string;
  name: string;
  closesAt: Date;
  perHouse: Record<HouseCode, { attendeeCount: number; rosterCount: number; percentage: number | null }>;
}

export interface HouseMonthComputation {
  month: string;
  label: string;
  /** True until the month is over — the standings are live and may still change. */
  provisional: boolean;
  events: MonthEventRow[];
  averages: Record<HouseCode, { average: number | null; eventCount: number }>;
  winners: HouseCode[];
}

function perHouseOf(t: EventTally): MonthEventRow["perHouse"] {
  return Object.fromEntries(
    HOUSE_CODES.map((h) => [h, { attendeeCount: t[h].attendeeCount, rosterCount: t[h].rosterCount, percentage: percentageOrNull(t[h].ratio) }]),
  ) as MonthEventRow["perHouse"];
}

/**
 * Each House's average attendance percentage across the month's
 * countsForMonthlyHouse events that have closed by `now`, against the current
 * roster. Before the month is over this is the LIVE, provisional standing.
 */
export async function computeHouseMonth(orgId: string, month: string, now: Date = new Date(), db: Db = prisma): Promise<HouseMonthComputation> {
  if (!isValidMonth(month)) throw new AppError("VALIDATION_FAILED", "Pick a month.");
  const { start, end } = monthRange(month);
  const events = await db.event.findMany({
    where: {
      orgId,
      deletedAt: null,
      countsForMonthlyHouse: true,
      status: DbEventStatus.SCHEDULED,
      closesAt: { gte: start, lt: end, lte: now },
    },
    select: { id: true, name: true, closesAt: true },
    orderBy: { closesAt: "asc" },
  });
  const roster = await loadHouseRoster(db, orgId);
  const attendees = await attendeesByEvent(db, events.map((e) => e.id));
  const tallies = events.map((e) => tallyEvent(roster, attendees.get(e.id)!));
  const averages = monthlyAverages(tallies);
  return {
    month,
    label: formatMonthKey(month),
    provisional: !isMonthOver(month, now),
    events: events.map((e, i) => ({ eventId: e.id, name: e.name, closesAt: e.closesAt!, perHouse: perHouseOf(tallies[i]) })),
    averages: Object.fromEntries(
      HOUSE_CODES.map((h) => [h, { average: percentageOrNull(averages[h].average), eventCount: averages[h].eventCount }]),
    ) as HouseMonthComputation["averages"],
    winners: ownTheMonthWinners(averages),
  };
}

function desiredMonthRows(c: HouseMonthComputation, awardedById: string | null): DesiredRow[] {
  const winners = new Set(c.winners);
  return HOUSE_CODES.filter((h) => c.averages[h].average !== null).map((h) => {
    const won = winners.has(h);
    const avg = c.averages[h].average!;
    return {
      house: h,
      category: "OWN_THE_MONTH" as const,
      points: won ? OWN_THE_MONTH_POINTS : 0,
      attendeeCount: null,
      rosterCount: null,
      percentage: avg,
      attendeeIds: [],
      reason: won
        ? `Own the Month — ${c.label}: highest average attendance (${avg.toFixed(2)}% over ${c.averages[h].eventCount} event(s))${winners.size > 1 ? ", tied" : ""}`
        : `Own the Month — ${c.label}: ${avg.toFixed(2)}% average over ${c.averages[h].eventCount} event(s), not the highest`,
      inputs: c.events.map((e) => ({ eventId: e.eventId, name: e.name, ...e.perHouse[h] })),
      awardedById,
    };
  });
}

export interface HouseMonthPreview extends HouseMonthComputation {
  calculatedAt: Date | null;
  /** What calculating now would change, House by House. Empty when it would change nothing. */
  diff: Array<{ house: HouseCode; from: number | null; to: number }>;
}

/** Read-only — the "already calculated, here's what would change" confirmation. */
export async function previewHouseMonth(orgId: string, month: string, now: Date = new Date()): Promise<HouseMonthPreview> {
  const [c, existing, calculated] = await Promise.all([
    computeHouseMonth(orgId, month, now),
    prisma.housePointAward.findMany({ where: { orgId, category: DbHouseCategory.OWN_THE_MONTH, periodMonth: month } }),
    getCalculatedHouseMonths(orgId),
  ]);
  const desired = new Map(desiredMonthRows(c, null).map((d) => [d.house, d.points]));
  const current = new Map(existing.map((r) => [r.house as HouseCode, r.points]));
  const diff = HOUSE_CODES.flatMap((h) => {
    const to = desired.get(h) ?? (current.has(h) ? 0 : null);
    const from = current.get(h) ?? null;
    if (to === null || from === to) return [];
    return [{ house: h, from, to }];
  });
  return { ...c, calculatedAt: calculated.get(month) ?? null, diff };
}

export interface CalculateHouseMonthResult {
  month: string;
  changes: HouseAwardChange[];
  unchanged: boolean;
  winners: HouseCode[];
}

/**
 * Materializes Own the Month for a month that is over: 2 points to the
 * highest average, every tied House included; 0-point rows for the rest so
 * the averages are on record. Idempotent — recalculating an unchanged month
 * writes nothing — and logged on EVERY run, which is how a month is known to
 * be calculated at all (see getCalculatedHouseMonths).
 *
 * Materialized rather than derived on purpose, like the Monthly Engagement
 * Champion: a month's result must not silently change because an event was
 * edited months later. Nothing recalculates a calculated month except an
 * admin asking to.
 */
export async function calculateHouseMonth(
  orgId: string,
  month: string,
  actor: string,
  now: Date = new Date(),
): Promise<CalculateHouseMonthResult> {
  if (!isValidMonth(month)) throw new AppError("VALIDATION_FAILED", "Pick a month.");
  if (!isMonthOver(month, now)) {
    throw new AppError("VALIDATION_FAILED", `${formatMonthKey(month)} isn't over yet — its standings are still provisional.`);
  }
  return withUniqueRetry(() =>
    prisma.$transaction(async (tx) => {
      const c = await computeHouseMonth(orgId, month, now, tx);
      const existing = await tx.housePointAward.findMany({
        where: { orgId, category: DbHouseCategory.OWN_THE_MONTH, periodMonth: month },
      });
      const changes = await syncRows(
        tx,
        { orgId, season: seasonOf(monthRange(month).start), eventId: null, periodMonth: month },
        existing,
        desiredMonthRows(c, await actorUserId(tx, orgId, actor)),
        () => `Own the Month — ${c.label}: no eligible events on recalculation`,
        now,
      );
      await log(tx, orgId, {
        actor,
        action: "calculate_house_month",
        target: month,
        detail:
          `winners: ${c.winners.join(", ") || "none"}; ` +
          (changes.length === 0 ? "no change" : changes.map((ch) => `${ch.house} ${ch.from ?? "new"}→${ch.to}`).join(", ")),
      });
      return { month, changes, unchanged: changes.length === 0, winners: c.winners };
    }),
  );
}

/** Month → when Own the Month was last calculated for it, from the AdminLog entry every calculation writes. */
export async function getCalculatedHouseMonths(orgId: string): Promise<Map<string, Date>> {
  const logs = await prisma.adminLog.findMany({
    where: { orgId, action: "calculate_house_month", target: { not: null } },
    select: { target: true, createdAt: true },
  });
  const months = new Map<string, Date>();
  for (const l of logs) {
    const prior = months.get(l.target!);
    if (!prior || l.createdAt > prior) months.set(l.target!, l.createdAt);
  }
  return months;
}

export interface HouseMonthNeedingRecalculation {
  month: string;
  label: string;
  calculatedAt: Date;
  events: Array<{ eventId: string; name: string; why: "trashed" | "changed" }>;
}

/**
 * Calculated months that something has touched since: an event in the month
 * was trashed (if it counted toward the month), restored, had attendance
 * added or removed, or had a House flag edited. Flagged — never recalculated
 * here. Recalculating the month clears its flag.
 */
export async function getHouseMonthsNeedingRecalculation(orgId: string): Promise<HouseMonthNeedingRecalculation[]> {
  const [calculated, events] = await Promise.all([
    getCalculatedHouseMonths(orgId),
    prisma.event.findMany({
      where: {
        orgId,
        closesAt: { not: null },
        OR: [{ houseChangedAt: { not: null } }, { deletedAt: { not: null }, countsForMonthlyHouse: true }],
      },
      select: { id: true, name: true, closesAt: true, deletedAt: true, houseChangedAt: true, countsForMonthlyHouse: true },
    }),
  ]);
  const byMonth = new Map<string, HouseMonthNeedingRecalculation>();
  for (const e of events) {
    const month = monthKeyOf(e.closesAt!);
    const calculatedAt = calculated.get(month);
    if (!calculatedAt) continue;
    const trashedSince = e.deletedAt !== null && e.countsForMonthlyHouse && e.deletedAt > calculatedAt;
    const changedSince = e.houseChangedAt !== null && e.houseChangedAt > calculatedAt;
    if (!trashedSince && !changedSince) continue;
    const entry = byMonth.get(month) ?? { month, label: formatMonthKey(month), calculatedAt, events: [] };
    entry.events.push({ eventId: e.id, name: e.name, why: trashedSince ? "trashed" : "changed" });
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** "October 2026's Own the Month was calculated using this event…" — for the trash dialogs, or null. */
export async function houseMonthWarningFor(
  orgId: string,
  event: { closesAt: Date | null; countsForMonthlyHouse: boolean },
  verb: "Deleting" | "Restoring",
): Promise<string | null> {
  if (!event.closesAt || !event.countsForMonthlyHouse) return null;
  const month = monthKeyOf(event.closesAt);
  if (!(await getCalculatedHouseMonths(orgId)).has(month)) return null;
  const label = formatMonthKey(month);
  return `${label}'s Own the Month (House points) was calculated ${verb === "Deleting" ? "using" : "without"} this event. ${verb} it may change the result — recalculate ${label} from the Houses tab.`;
}

// ---------------------------------------------------------------------------
// When scoring runs — the lazy sweep, and "Recalculate all"
// ---------------------------------------------------------------------------

export const HOUSE_SWEEP_KEY = "HOUSE_SCORING_LAST_RUN";
export const HOUSE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Same atomic claim as lib/repo.ts claimTrashSweep, on its own key: one sweep per interval however many admins load a page. */
async function claimHouseSweep(orgId: string, now: Date): Promise<boolean> {
  const threshold = new Date(now.getTime() - HOUSE_SWEEP_INTERVAL_MS).toISOString();
  const updated = await prisma.config.updateMany({
    where: { orgId, key: HOUSE_SWEEP_KEY, value: { lte: threshold } },
    data: { value: now.toISOString() },
  });
  if (updated.count === 1) return true;
  try {
    await prisma.config.create({ data: { orgId, key: HOUSE_SWEEP_KEY, value: now.toISOString() } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

/** Live, closed, current-season events with an event-level House flag. */
async function scorableEvents(orgId: string, season: string, now: Date) {
  const range = seasonRange(season);
  return prisma.event.findMany({
    where: {
      orgId,
      deletedAt: null,
      status: DbEventStatus.SCHEDULED,
      closesAt: { lte: now, ...(range ? { gte: range.start, lt: range.end } : {}) },
      OR: [{ countsForShowUp: true }, { countsForRepYourHouse: true }, { isHouseCompetition: true }],
    },
    select: { id: true, closesAt: true, houseScoredAt: true, houseScoringStale: true },
    orderBy: { closesAt: "asc" },
  });
}

/** Months of `season` that are over and contain at least one countsForMonthlyHouse event. */
async function monthsWithEligibleEvents(orgId: string, season: string, now: Date): Promise<string[]> {
  const range = seasonRange(season);
  if (!range) return [];
  const events = await prisma.event.findMany({
    where: {
      orgId,
      deletedAt: null,
      countsForMonthlyHouse: true,
      status: DbEventStatus.SCHEDULED,
      closesAt: { gte: range.start, lt: range.end, lte: now },
    },
    select: { closesAt: true },
  });
  return [...new Set(events.map((e) => monthKeyOf(e.closesAt!)))].filter((m) => isMonthOver(m, now)).sort();
}

export type HouseSweepResult =
  | { ran: false; reason: "rate_limited" }
  | { ran: true; eventsScored: number; monthsCalculated: string[]; failures: Array<{ target: string; error: string }> };

/**
 * There is no cron. House scoring runs here, lazily — after an /admin or
 * /admin/houses load, at most once per HOUSE_SWEEP_INTERVAL_MS — plus the
 * manual buttons and GET /api/cron/house-scoring.
 *
 * What it does, current season only:
 *   - scores every closed event that is due: never scored, reopened and
 *     closed again since, or marked stale by an attendance/flag change
 *   - calculates Own the Month for every month that is over and has never
 *     been calculated. A month that HAS been calculated is never touched
 *     here, even if it's flagged — that is an admin's call.
 */
export async function runHouseScoringSweep(
  orgId: string,
  options: { now?: Date; force?: boolean; actor?: string } = {},
): Promise<HouseSweepResult> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? "system";
  if (!options.force && !(await claimHouseSweep(orgId, now))) return { ran: false, reason: "rate_limited" };

  const season = await currentSeason(prisma, orgId);
  const failures: Array<{ target: string; error: string }> = [];
  let eventsScored = 0;

  for (const e of await scorableEvents(orgId, season, now)) {
    const due = e.houseScoredAt === null || e.houseScoringStale || e.houseScoredAt < e.closesAt!;
    if (!due) continue;
    try {
      await processEventHouseScoring(orgId, e.id, { actor, now, trigger: "automatic" });
      eventsScored += 1;
    } catch (err) {
      failures.push({ target: e.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const calculated = await getCalculatedHouseMonths(orgId);
  const monthsCalculated: string[] = [];
  for (const month of await monthsWithEligibleEvents(orgId, season, now)) {
    if (calculated.has(month)) continue;
    try {
      await calculateHouseMonth(orgId, month, actor, now);
      monthsCalculated.push(month);
    } catch (err) {
      failures.push({ target: month, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ran: true, eventsScored, monthsCalculated, failures };
}

export interface RecalculateAllResult {
  events: ProcessEventResult[];
  months: CalculateHouseMonthResult[];
  failures: Array<{ target: string; error: string }>;
}

/**
 * The Houses tab's "Recalculate all": every scorable event of the current
 * season against the current roster, then every month of the season that is
 * over — calculated ones included, because an admin pressed the button. The
 * result lists exactly what moved.
 */
export async function recalculateAllHouseScoring(orgId: string, actor: string, now: Date = new Date()): Promise<RecalculateAllResult> {
  const season = await currentSeason(prisma, orgId);
  const result: RecalculateAllResult = { events: [], months: [], failures: [] };
  for (const e of await scorableEvents(orgId, season, now)) {
    try {
      result.events.push(await processEventHouseScoring(orgId, e.id, { actor, now, trigger: "recalculate all" }));
    } catch (err) {
      result.failures.push({ target: e.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const months = new Set(await monthsWithEligibleEvents(orgId, season, now));
  for (const m of (await getCalculatedHouseMonths(orgId)).keys()) {
    if (seasonOf(monthRange(m).start) === season && isMonthOver(m, now)) months.add(m);
  }
  for (const month of [...months].sort()) {
    try {
      result.months.push(await calculateHouseMonth(orgId, month, actor, now));
    } catch (err) {
      result.failures.push({ target: month, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Manual awards and revokes
// ---------------------------------------------------------------------------

export async function createManualHouseAward(input: {
  orgId: string;
  house: string;
  points: number;
  reason: string;
  actor: string;
}): Promise<void> {
  const { orgId } = input;
  if (!(HOUSE_CODES as readonly string[]).includes(input.house)) throw new AppError("VALIDATION_FAILED", "Pick a House.");
  if (!Number.isInteger(input.points) || input.points === 0) {
    throw new AppError("VALIDATION_FAILED", "Points must be a whole number other than zero.");
  }
  if (Math.abs(input.points) > HOUSE_MANUAL_MAX_ABS) {
    throw new AppError("VALIDATION_FAILED", `A single adjustment can't move a House more than ${HOUSE_MANUAL_MAX_ABS} points.`);
  }
  const reason = input.reason.trim();
  if (reason.length < HOUSE_MANUAL_REASON_MIN_LENGTH) {
    throw new AppError("VALIDATION_FAILED", `Give a reason of at least ${HOUSE_MANUAL_REASON_MIN_LENGTH} characters.`);
  }
  await prisma.$transaction(async (tx) => {
    const season = await currentSeason(tx, orgId);
    if (!season) throw new AppError("VALIDATION_FAILED", "Set the current season in Settings first.");
    await tx.housePointAward.create({
      data: {
        orgId,
        season,
        house: input.house as DbHouse,
        category: DbHouseCategory.MANUAL,
        points: input.points,
        reason,
        awardedById: await actorUserId(tx, orgId, input.actor),
      },
    });
    await log(tx, orgId, {
      actor: input.actor,
      action: "house_manual_award",
      target: input.house,
      detail: `${input.points > 0 ? "+" : ""}${input.points} — ${reason}`,
    });
  });
}

/** Revoking takes the row out of every total; it is kept, with who and why. A recalculation never un-revokes it. */
export async function revokeHouseAward(orgId: string, id: string, note: string, actor: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "A note is required to revoke a House award.");
  await prisma.$transaction(async (tx) => {
    const row = await tx.housePointAward.findFirst({ where: { id, orgId } });
    if (!row) throw new AppError("NOT_FOUND", "Award not found");
    if (row.revokedAt) throw new AppError("VALIDATION_FAILED", "That award is already revoked.");
    await tx.housePointAward.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById: await actorUserId(tx, orgId, actor), revokeNote: trimmed },
    });
    await log(tx, orgId, { actor, action: "house_revoke_award", target: id, detail: `${row.house} ${row.category} ${row.points} — ${trimmed}` });
  });
}

// ---------------------------------------------------------------------------
// Reads for /admin/houses and /admin/seasons
// ---------------------------------------------------------------------------

export interface HouseInfo {
  code: HouseCode;
  name: string;
  color: string;
}

/** Display name and color per House, from Config.HOUSES_LIST — a renamed House keeps its color, and an unmapped one falls back to its code. */
export async function getHouseInfo(orgId: string): Promise<Record<HouseCode, HouseInfo>> {
  const raw = (await prisma.config.findUnique({ where: { orgId_key: { orgId, key: "HOUSES_LIST" } } }))?.value ?? "";
  const configured = parseHouses(raw);
  return Object.fromEntries(
    HOUSE_CODES.map((code) => {
      const h = configured.find((c) => codeFromName(c.name) === code || c.code === code);
      const fallback = DEFAULT_HOUSES.find((d) => d.code === code);
      return [code, { code, name: h?.name ?? fallback?.name ?? code, color: h?.color ?? fallback?.color ?? "" }];
    }),
  ) as Record<HouseCode, HouseInfo>;
}

/** The rows that count toward `season`: not revoked, and not tied to an event in the trash. */
function countingAwardsWhere(orgId: string, season: string): Prisma.HousePointAwardWhereInput {
  return { orgId, season, revokedAt: null, OR: [{ eventId: null }, { event: { deletedAt: null } }] };
}

export interface HouseBoard {
  season: string;
  currentSeason: string;
  totals: Array<HouseTotal & HouseInfo>;
}

/** The House leaderboard for a season — the current one by default. Derived by summing rows, every time. */
export async function getHouseBoard(orgId: string, season?: string): Promise<HouseBoard> {
  const current = await currentSeason(prisma, orgId);
  const s = season || current;
  const [awards, info] = await Promise.all([
    prisma.housePointAward.findMany({
      where: countingAwardsWhere(orgId, s),
      select: { house: true, category: true, points: true, revokedAt: true },
    }),
    getHouseInfo(orgId),
  ]);
  const totals = houseTotals(
    awards.map((a) => ({ house: a.house as HouseCode, category: a.category as HouseCategoryCode, points: a.points, revokedAt: a.revokedAt })),
  );
  return { season: s, currentSeason: current, totals: totals.map((t) => ({ ...t, ...info[t.house] })) };
}

/** Every season that has House awards, newest first, plus the current one — what /admin/seasons lists. */
export async function getHouseSeasons(orgId: string): Promise<string[]> {
  const [rows, current] = await Promise.all([
    prisma.housePointAward.findMany({ where: { orgId }, select: { season: true }, distinct: ["season"] }),
    currentSeason(prisma, orgId),
  ]);
  const seasons = new Set(rows.map((r) => r.season));
  if (current) seasons.add(current);
  return [...seasons].sort().reverse();
}

export interface HouseAwardRow {
  id: string;
  house: HouseCode;
  category: HouseCategoryCode;
  points: number;
  eventId: string | null;
  eventName: string | null;
  eventInTrash: boolean;
  periodMonth: string | null;
  attendeeCount: number | null;
  rosterCount: number | null;
  percentage: number | null;
  reason: string;
  awardedAt: Date;
  awardedBy: string | null;
  recalculatedAt: Date | null;
  originalSnapshot: { points: number; attendeeCount: number | null; rosterCount: number | null; percentage: number | null } | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeNote: string | null;
}

export async function getHousePointsHistory(orgId: string, season: string): Promise<HouseAwardRow[]> {
  const rows = await prisma.housePointAward.findMany({
    where: { orgId, season },
    include: {
      event: { select: { name: true, deletedAt: true } },
      awardedBy: { select: { email: true, firstName: true, lastName: true } },
      revokedBy: { select: { email: true, firstName: true, lastName: true } },
    },
    orderBy: [{ awardedAt: "desc" }, { house: "asc" }],
  });
  const who = (u: { email: string; firstName: string; lastName: string } | null) =>
    u ? memberDisplayName(u.firstName, u.lastName, u.email) : null;
  return rows.map((r) => ({
    id: r.id,
    house: r.house as HouseCode,
    category: r.category as HouseCategoryCode,
    points: r.points,
    eventId: r.eventId,
    eventName: r.event?.name ?? null,
    eventInTrash: r.event?.deletedAt != null,
    periodMonth: r.periodMonth,
    attendeeCount: r.attendeeCount,
    rosterCount: r.rosterCount,
    percentage: decimalToNumber(r.percentage),
    reason: r.reason,
    awardedAt: r.awardedAt,
    awardedBy: who(r.awardedBy),
    recalculatedAt: r.recalculatedAt,
    originalSnapshot: (r.originalSnapshot as HouseAwardRow["originalSnapshot"]) ?? null,
    revokedAt: r.revokedAt,
    revokedBy: who(r.revokedBy),
    revokeNote: r.revokeNote,
  }));
}

export interface HouseMemberRow {
  id: string;
  name: string;
  email: string;
  attended: number;
}

export interface HouseMembership {
  house: HouseCode;
  members: HouseMemberRow[];
  /** Selected this House but not yet verified — NOT counted anywhere until verified. */
  pendingCount: number;
  /** E-Board/admins in this House — shown, never counted (see lib/house-scoring.ts houseForRoster). */
  officerCount: number;
}

/** Per House: the members who count, each with how many of the season's House events they attended, plus who's visible but excluded. */
export async function getHouseMembership(orgId: string, season: string, now: Date = new Date()): Promise<{ events: number; houses: HouseMembership[] }> {
  const roster = await loadHouseRoster(prisma, orgId);
  const ids = HOUSE_CODES.flatMap((h) => [...roster[h]]);
  const range = seasonRange(season);
  const [users, others, houseEvents] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, firstName: true, lastName: true } }),
    prisma.user.findMany({
      where: { orgId, deletedAt: null, house: { not: null }, OR: [{ houseVerifiedAt: null }, { role: { in: [DbRole.EBOARD, DbRole.ADMIN] } }] },
      select: { house: true, houseVerifiedAt: true, role: true },
    }),
    prisma.event.findMany({
      where: {
        orgId,
        deletedAt: null,
        status: DbEventStatus.SCHEDULED,
        closesAt: { lte: now, ...(range ? { gte: range.start, lt: range.end } : {}) },
        OR: [{ countsForShowUp: true }, { countsForRepYourHouse: true }, { countsForMonthlyHouse: true }],
      },
      select: { id: true },
    }),
  ]);
  const regs = await prisma.registration.groupBy({
    by: ["userId"],
    where: { userId: { in: ids }, eventId: { in: houseEvents.map((e) => e.id) } },
    _count: { _all: true },
  });
  const attended = new Map(regs.map((r) => [r.userId, r._count._all]));
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    events: houseEvents.length,
    houses: HOUSE_CODES.map((house) => {
      const members = [...roster[house]]
        .map((id) => byId.get(id)!)
        .filter(Boolean)
        .map((u) => ({ id: u.id, name: memberDisplayName(u.firstName, u.lastName, u.email), email: u.email, attended: attended.get(u.id) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const mine = others.filter((o) => codeFromName(o.house!) === house);
      return {
        house,
        members,
        pendingCount: mine.filter((o) => o.houseVerifiedAt === null && o.role === DbRole.GENERAL).length,
        officerCount: mine.filter((o) => o.role !== DbRole.GENERAL).length,
      };
    }),
  };
}

export interface HouseEventStatRow extends MonthEventRow {
  flags: { showUp: boolean; repYourHouse: boolean; monthly: boolean; competition: boolean };
  houseScoredAt: Date | null;
  stale: boolean;
  competitionWinners: HouseCode[];
}

/**
 * Every closed House event of the season with each House's percentage
 * against the CURRENT roster — the live view. What an award actually said at
 * the time is on its row in the points history.
 */
export async function getHouseEventStats(orgId: string, season: string, now: Date = new Date()): Promise<HouseEventStatRow[]> {
  const range = seasonRange(season);
  const events = await prisma.event.findMany({
    where: {
      orgId,
      deletedAt: null,
      status: DbEventStatus.SCHEDULED,
      closesAt: { lte: now, ...(range ? { gte: range.start, lt: range.end } : {}) },
      OR: [{ countsForShowUp: true }, { countsForRepYourHouse: true }, { countsForMonthlyHouse: true }, { isHouseCompetition: true }],
    },
    orderBy: { closesAt: "desc" },
  });
  const roster = await loadHouseRoster(prisma, orgId);
  const attendees = await attendeesByEvent(prisma, events.map((e) => e.id));
  return events.map((e) => ({
    eventId: e.id,
    name: e.name,
    closesAt: e.closesAt!,
    perHouse: perHouseOf(tallyEvent(roster, attendees.get(e.id)!)),
    flags: { showUp: e.countsForShowUp, repYourHouse: e.countsForRepYourHouse, monthly: e.countsForMonthlyHouse, competition: e.isHouseCompetition },
    houseScoredAt: e.houseScoredAt,
    stale: e.houseScoringStale || (e.houseScoredAt !== null && e.houseScoredAt < e.closesAt!),
    competitionWinners: e.competitionWinners as HouseCode[],
  }));
}

export interface HouseMonthlyStandings {
  current: HouseMonthComputation;
  /** Months of the season that are over, newest first, with their materialized result (or null if never calculated). */
  past: Array<{ month: string; label: string; calculatedAt: Date | null; winners: HouseCode[] }>;
  needingRecalculation: HouseMonthNeedingRecalculation[];
}

export async function getHouseMonthlyStandings(orgId: string, season: string, now: Date = new Date()): Promise<HouseMonthlyStandings> {
  const [current, calculated, winnerRows, needingRecalculation, eligibleMonths] = await Promise.all([
    computeHouseMonth(orgId, monthKeyOf(now), now),
    getCalculatedHouseMonths(orgId),
    prisma.housePointAward.findMany({
      where: { orgId, season, category: DbHouseCategory.OWN_THE_MONTH, points: { gt: 0 }, revokedAt: null },
      select: { periodMonth: true, house: true },
    }),
    getHouseMonthsNeedingRecalculation(orgId),
    monthsWithEligibleEvents(orgId, season, now),
  ]);
  const months = new Set(eligibleMonths);
  for (const m of calculated.keys()) if (seasonOf(monthRange(m).start) === season) months.add(m);
  const past = [...months]
    .filter((m) => isMonthOver(m, now))
    .sort()
    .reverse()
    .map((month) => ({
      month,
      label: formatMonthKey(month),
      calculatedAt: calculated.get(month) ?? null,
      winners: winnerRows.filter((r) => r.periodMonth === month).map((r) => r.house as HouseCode),
    }));
  return { current, past, needingRecalculation };
}

/** For the trash bin's purge snapshot — the rows that cascade away with a permanently deleted event. */
export async function getHouseAwardsForEvent(orgId: string, eventId: string) {
  return prisma.housePointAward.findMany({ where: { orgId, eventId } });
}
