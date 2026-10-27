/**
 * House Points — the THIRD scoring track, and the pure half of it.
 *
 * Nothing here reads the database or the clock. lib/house-repo.ts loads the
 * roster and the registrations, calls these functions, and writes the
 * HousePointAward rows they describe. Nothing in lib/points.ts imports this
 * file and nothing here imports lib/points.ts's scoring: the member and E-Board
 * tracks cannot be moved by anything in this module.
 *
 * The one input shared with the member track is the Registration row itself —
 * a member who checks in earns their own points AND counts toward their
 * House's attendance, from the same row. There is no second attendance record.
 *
 * Every comparison is EXACT. Percentages are kept as fractions of integers
 * (BigInt numerator/denominator) and compared by cross-multiplication, so
 * "2 of 3" vs "4 of 6" is a tie and 74.999…% is never rounded up to a tier.
 * percentageOf() rounds, and is for storage/display only.
 */

import { codeFromName } from "./houses";

export const HOUSE_CODES = ["JOHNSON", "JEMISON", "LATIMER", "DEAN"] as const;
export type HouseCode = (typeof HOUSE_CODES)[number];

export type HouseCategoryCode = "SHOW_UP" | "REP_YOUR_HOUSE" | "WIN" | "OWN_THE_MONTH" | "MANUAL";

/** The categories written per event — OWN_THE_MONTH is per month and MANUAL is per admin action. */
export const EVENT_CATEGORIES = ["SHOW_UP", "REP_YOUR_HOUSE", "WIN"] as const;
export type EventHouseCategory = (typeof EVENT_CATEGORIES)[number];

export const HOUSE_CATEGORY_LABEL: Record<HouseCategoryCode, string> = {
  SHOW_UP: "Show Up",
  REP_YOUR_HOUSE: "Rep Your House",
  WIN: "Win",
  OWN_THE_MONTH: "Own the Month",
  MANUAL: "Manual",
};

export const REP_YOUR_HOUSE_POINTS = 1;
export const WIN_POINTS = 1;
export const OWN_THE_MONTH_POINTS = 2;

/**
 * User.house holds a House's display NAME ("Jemison" — see lib/houses.ts), not
 * a code. Mapped through the same codeFromName that /admin/settings uses to
 * derive House codes, so "Jemison", "jemison " and "JEMISON" all land on
 * JEMISON. Anything that isn't one of the four is "no House" for scoring.
 */
export function houseFromUserValue(value: string | null | undefined): HouseCode | null {
  if (!value || !value.trim()) return null;
  const code = codeFromName(value);
  return (HOUSE_CODES as readonly string[]).includes(code) ? (code as HouseCode) : null;
}

// ---------------------------------------------------------------------------
// Exact fractions
// ---------------------------------------------------------------------------

export interface Fraction {
  num: bigint;
  den: bigint;
}

export function fraction(num: number, den: number): Fraction {
  if (den <= 0) throw new Error("fraction denominator must be positive");
  return { num: BigInt(num), den: BigInt(den) };
}

/** -1, 0, 1. Both denominators are positive, so cross-multiplying preserves order. */
export function compareFractions(a: Fraction, b: Fraction): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left > right ? 1 : -1;
}

function addFractions(a: Fraction, b: Fraction): Fraction {
  return { num: a.num * b.den + b.num * a.den, den: a.den * b.den };
}

/** The mean of a non-empty list of fractions, still exact. */
export function averageFractions(values: Fraction[]): Fraction {
  if (values.length === 0) throw new Error("average of nothing");
  const sum = values.reduce(addFractions);
  return { num: sum.num, den: sum.den * BigInt(values.length) };
}

/** The fraction as a percentage, rounded to 4 decimal places — what HousePointAward.percentage stores. Display/audit only. */
export function percentageOf(f: Fraction): number {
  // Scale to 1/10000ths of a percent with integer math, rounding half up.
  const scaled = (f.num * BigInt(2_000_000) + f.den) / (f.den * BigInt(2));
  return Number(scaled) / 10_000;
}

export function percentageOrNull(f: Fraction | null): number | null {
  return f ? percentageOf(f) : null;
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

export interface HouseRosterCandidate {
  id: string;
  house: string | null;
  houseVerifiedAt: Date | null;
  role: "admin" | "eboard" | "general" | "guest";
  deletedAt: Date | null;
  suspended: boolean;
}

/**
 * Who counts toward a House — in the denominator, and therefore the only
 * people who can be in the numerator. All of these, live at scoring time:
 *
 *   - GENERAL members only. E-Board and admins are excluded: attendance is
 *     expected of officers, so counting them would inflate their House's
 *     percentage for doing their job. Guests have no House at all.
 *   - a House that maps to one of the four (houseFromUserValue)
 *   - houseVerifiedAt set — a pending (unverified) House is not a House yet
 *   - not in the trash, not suspended
 */
export function houseForRoster(m: HouseRosterCandidate): HouseCode | null {
  if (m.role !== "general") return null;
  if (m.deletedAt !== null || m.suspended) return null;
  if (m.houseVerifiedAt === null) return null;
  return houseFromUserValue(m.house);
}

export type HouseRoster = Record<HouseCode, Set<string>>;

export function buildRoster(members: HouseRosterCandidate[]): HouseRoster {
  const roster = emptyRoster();
  for (const m of members) {
    const house = houseForRoster(m);
    if (house) roster[house].add(m.id);
  }
  return roster;
}

function emptyRoster(): HouseRoster {
  return { JOHNSON: new Set(), JEMISON: new Set(), LATIMER: new Set(), DEAN: new Set() };
}

// ---------------------------------------------------------------------------
// One event's attendance, per House
// ---------------------------------------------------------------------------

export interface HouseTally {
  house: HouseCode;
  attendeeIds: string[];
  attendeeCount: number;
  rosterCount: number;
  /** null when the House has no assigned members — undefined, NOT 0%. */
  ratio: Fraction | null;
}

export type EventTally = Record<HouseCode, HouseTally>;

/**
 * Unique House members attending / members assigned to that House. An
 * attendee who isn't on any roster (no House, unverified, officer, guest,
 * trashed) is dropped here, so they are in neither half of the fraction.
 * `attendeeUserIds` may contain duplicates; each member counts once.
 */
export function tallyEvent(roster: HouseRoster, attendeeUserIds: Iterable<string>): EventTally {
  const attending = new Set(attendeeUserIds);
  const out = {} as EventTally;
  for (const house of HOUSE_CODES) {
    const members = roster[house];
    const attendeeIds = [...members].filter((id) => attending.has(id)).sort();
    out[house] = {
      house,
      attendeeIds,
      attendeeCount: attendeeIds.length,
      rosterCount: members.size,
      ratio: members.size === 0 ? null : fraction(attendeeIds.length, members.size),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const FIFTY = fraction(50, 100);
const SEVENTY_FIVE = fraction(75, 100);

/** SHOW UP: < 50% → 0, 50% to < 75% → 1, ≥ 75% → 2. Tiers don't stack. */
export function showUpPoints(ratio: Fraction): number {
  if (compareFractions(ratio, SEVENTY_FIVE) >= 0) return 2;
  if (compareFractions(ratio, FIFTY) >= 0) return 1;
  return 0;
}

/**
 * The Houses tied for the highest value among those that HAVE a value. An
 * undefined House (null) is excluded from the comparison rather than ranked
 * last. Returns [] when nobody is above zero — "no House members attended at
 * all" awards no one.
 */
export function topHouses(values: Partial<Record<HouseCode, Fraction | null>>): HouseCode[] {
  const defined = HOUSE_CODES.filter((h) => values[h]).map((h) => ({ house: h, value: values[h]! }));
  if (defined.length === 0) return [];
  const best = defined.reduce((a, b) => (compareFractions(b.value, a.value) > 0 ? b : a)).value;
  if (best.num === BigInt(0)) return [];
  return defined.filter((d) => compareFractions(d.value, best) === 0).map((d) => d.house);
}

/** REP YOUR HOUSE: the highest percentage gets 1; ties all get 1. */
export function repYourHouseWinners(tally: EventTally): HouseCode[] {
  return topHouses(Object.fromEntries(HOUSE_CODES.map((h) => [h, tally[h].ratio])));
}

export interface MonthAverage {
  house: HouseCode;
  /** null when the House had no defined percentage at any eligible event that month — excluded, not 0. */
  average: Fraction | null;
  /** The per-event percentages that were averaged. */
  eventCount: number;
}

/**
 * OWN THE MONTH's input: each House's MEAN attendance percentage across the
 * month's countsForMonthlyHouse events. Averaging percentages, not pooling
 * attendance — a small event counts as much as a large one. An event at which
 * a House had no assigned members contributes nothing to that House's mean.
 */
export function monthlyAverages(tallies: EventTally[]): Record<HouseCode, MonthAverage> {
  const out = {} as Record<HouseCode, MonthAverage>;
  for (const house of HOUSE_CODES) {
    const ratios = tallies.map((t) => t[house].ratio).filter((r): r is Fraction => r !== null);
    out[house] = { house, average: ratios.length ? averageFractions(ratios) : null, eventCount: ratios.length };
  }
  return out;
}

/** OWN THE MONTH: the highest average gets 2; ties all get 2. */
export function ownTheMonthWinners(averages: Record<HouseCode, MonthAverage>): HouseCode[] {
  return topHouses(Object.fromEntries(HOUSE_CODES.map((h) => [h, averages[h].average])));
}

// ---------------------------------------------------------------------------
// What an event's rows should say
// ---------------------------------------------------------------------------

export interface EventHouseFlags {
  countsForShowUp: boolean;
  countsForRepYourHouse: boolean;
  isHouseCompetition: boolean;
  competitionWinners: HouseCode[];
}

export interface DesiredHouseAward {
  house: HouseCode;
  category: EventHouseCategory;
  points: number;
  attendeeCount: number | null;
  rosterCount: number | null;
  percentage: number | null;
  attendeeIds: string[];
  reason: string;
  inputs: unknown;
}

function pct(ratio: Fraction | null): string {
  return ratio ? `${percentageOf(ratio).toFixed(2)}%` : "no members assigned";
}

/** Every House's numbers, as REP_YOUR_HOUSE's comparison saw them — stored on its rows so the "why" survives. */
function comparisonInputs(tally: EventTally) {
  return HOUSE_CODES.map((h) => ({
    house: h,
    attendeeCount: tally[h].attendeeCount,
    rosterCount: tally[h].rosterCount,
    percentage: tally[h].ratio ? percentageOf(tally[h].ratio) : null,
  }));
}

/**
 * The full set of rows an event's House scoring should produce, for the
 * categories in `only` (all three by default). A House with an undefined
 * percentage gets no SHOW_UP/REP_YOUR_HOUSE row at all; a scored House that
 * earned nothing gets a 0-point row recording the percentage that produced
 * the 0. WIN rows exist only for winners.
 */
export function desiredEventAwards(
  flags: EventHouseFlags,
  tally: EventTally,
  only: readonly EventHouseCategory[] = EVENT_CATEGORIES,
): DesiredHouseAward[] {
  const rows: DesiredHouseAward[] = [];
  const base = (h: HouseCode) => ({
    house: h,
    attendeeCount: tally[h].attendeeCount,
    rosterCount: tally[h].rosterCount,
    percentage: tally[h].ratio ? percentageOf(tally[h].ratio) : null,
    attendeeIds: tally[h].attendeeIds,
  });

  if (flags.countsForShowUp && only.includes("SHOW_UP")) {
    for (const h of HOUSE_CODES) {
      const ratio = tally[h].ratio;
      if (!ratio) continue;
      const points = showUpPoints(ratio);
      rows.push({
        ...base(h),
        category: "SHOW_UP",
        points,
        reason: `Show Up — ${tally[h].attendeeCount}/${tally[h].rosterCount} attended (${pct(ratio)}) → ${points}`,
        inputs: null,
      });
    }
  }

  if (flags.countsForRepYourHouse && only.includes("REP_YOUR_HOUSE")) {
    const winners = new Set(repYourHouseWinners(tally));
    const inputs = comparisonInputs(tally);
    for (const h of HOUSE_CODES) {
      const ratio = tally[h].ratio;
      if (!ratio) continue;
      const won = winners.has(h);
      rows.push({
        ...base(h),
        category: "REP_YOUR_HOUSE",
        points: won ? REP_YOUR_HOUSE_POINTS : 0,
        reason: won
          ? `Rep Your House — highest attendance (${pct(ratio)})${winners.size > 1 ? `, tied with ${winners.size - 1} other House(s)` : ""}`
          : `Rep Your House — ${pct(ratio)}, not the highest`,
        inputs,
      });
    }
  }

  if (flags.isHouseCompetition && only.includes("WIN")) {
    for (const h of new Set(flags.competitionWinners)) {
      rows.push({
        house: h,
        category: "WIN",
        points: WIN_POINTS,
        attendeeCount: null,
        rosterCount: null,
        percentage: null,
        attendeeIds: [],
        reason: "Won the House competition",
        inputs: null,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// The leaderboard
// ---------------------------------------------------------------------------

export interface HouseAwardForTotal {
  house: HouseCode;
  category: HouseCategoryCode;
  points: number;
  revokedAt: Date | null;
}

export interface HouseTotal {
  house: HouseCode;
  total: number;
  byCategory: Record<HouseCategoryCode, number>;
  rank: number;
}

/**
 * Totals by summing award rows — never a stored counter. The caller has
 * already scoped the rows to one season and dropped those whose event is in
 * the trash. Ranked with standard competition ranking (10, 10, 7, 3 → 1, 1,
 * 3, 4); Houses on equal totals share a rank and are listed alphabetically.
 */
export function houseTotals(awards: HouseAwardForTotal[]): HouseTotal[] {
  const rows = HOUSE_CODES.map((house) => {
    const byCategory: Record<HouseCategoryCode, number> = { SHOW_UP: 0, REP_YOUR_HOUSE: 0, WIN: 0, OWN_THE_MONTH: 0, MANUAL: 0 };
    for (const a of awards) {
      if (a.house !== house || a.revokedAt !== null) continue;
      byCategory[a.category] += a.points;
    }
    const total = Object.values(byCategory).reduce((s, n) => s + n, 0);
    return { house, total, byCategory, rank: 0 };
  });
  rows.sort((a, b) => b.total - a.total || a.house.localeCompare(b.house));
  let seen = 0;
  let prev: number | null = null;
  let rank = 0;
  for (const row of rows) {
    seen += 1;
    if (prev === null || row.total !== prev) {
      rank = seen;
      prev = row.total;
    }
    row.rank = rank;
  }
  return rows;
}
