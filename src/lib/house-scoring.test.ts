/**
 * The House Points rules, pure — no database. The DB half (idempotency, the
 * trash, corrections, seasons, and the proof that the member and E-Board
 * tracks don't move) is house-repo.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  buildRoster,
  desiredEventAwards,
  fraction,
  houseForRoster,
  houseFromUserValue,
  houseTotals,
  monthlyAverages,
  ownTheMonthWinners,
  percentageOf,
  repYourHouseWinners,
  showUpPoints,
  tallyEvent,
  type HouseRosterCandidate,
} from "./house-scoring";

function member(id: string, house: string | null, overrides: Partial<HouseRosterCandidate> = {}): HouseRosterCandidate {
  return { id, house, houseVerifiedAt: new Date(2026, 8, 1), role: "general", deletedAt: null, suspended: false, ...overrides };
}

/** A roster of `n` verified General members per House, ids like "JEMISON-0". */
function rosterOf(sizes: Partial<Record<"Johnson" | "Jemison" | "Latimer" | "Dean", number>>) {
  const members: HouseRosterCandidate[] = [];
  for (const [house, n] of Object.entries(sizes)) {
    for (let i = 0; i < (n ?? 0); i++) members.push(member(`${house.toUpperCase()}-${i}`, house));
  }
  return buildRoster(members);
}

const attend = (house: string, count: number) => Array.from({ length: count }, (_, i) => `${house.toUpperCase()}-${i}`);

describe("Show Up tiers", () => {
  it("49%, 50%, 74%, 75%, 100% produce 0, 1, 1, 2, 2", () => {
    expect([49, 50, 74, 75, 100].map((p) => showUpPoints(fraction(p, 100)))).toEqual([0, 1, 1, 2, 2]);
  });

  it("compares exactly — 74.99% is not rounded up to the 75% tier, and 3/4 is exactly 75%", () => {
    expect(showUpPoints(fraction(7499, 10000))).toBe(1);
    expect(showUpPoints(fraction(3, 4))).toBe(2);
    expect(showUpPoints(fraction(1, 2))).toBe(1);
    expect(showUpPoints(fraction(49_999, 100_000))).toBe(0);
  });

  it("tiers don't stack: one row per House, worth the single tier it reached", () => {
    const roster = rosterOf({ Jemison: 4 });
    const rows = desiredEventAwards(
      { countsForShowUp: true, countsForRepYourHouse: false, isHouseCompetition: false, competitionWinners: [] },
      tallyEvent(roster, attend("Jemison", 4)),
    );
    expect(rows.filter((r) => r.house === "JEMISON")).toHaveLength(1);
    expect(rows.find((r) => r.house === "JEMISON")!.points).toBe(2);
  });
});

describe("Rep Your House", () => {
  it("ties award 1 point to each tied House — 2/4 and 5/10 are the same 50%", () => {
    const roster = rosterOf({ Jemison: 4, Latimer: 10, Dean: 10 });
    const tally = tallyEvent(roster, [...attend("Jemison", 2), ...attend("Latimer", 5), ...attend("Dean", 3)]);
    expect(repYourHouseWinners(tally).sort()).toEqual(["JEMISON", "LATIMER"]);
    const rows = desiredEventAwards(
      { countsForShowUp: false, countsForRepYourHouse: true, isHouseCompetition: false, competitionWinners: [] },
      tally,
    );
    expect(Object.fromEntries(rows.map((r) => [r.house, r.points]))).toEqual({ JEMISON: 1, LATIMER: 1, DEAN: 0 });
  });

  it("no attendance from any House awards nothing", () => {
    const tally = tallyEvent(rosterOf({ Johnson: 3, Jemison: 3, Latimer: 3, Dean: 3 }), []);
    expect(repYourHouseWinners(tally)).toEqual([]);
    const rows = desiredEventAwards(
      { countsForShowUp: true, countsForRepYourHouse: true, isHouseCompetition: false, competitionWinners: [] },
      tally,
    );
    expect(rows.reduce((s, r) => s + r.points, 0)).toBe(0);
  });

  it("a House with zero assigned members is excluded, not scored as 0%", () => {
    // Johnson has nobody assigned. If it were treated as 0% it would simply
    // lose; treated as undefined it doesn't appear in the comparison at all.
    const tally = tallyEvent(rosterOf({ Jemison: 2, Latimer: 2, Dean: 2 }), [...attend("Jemison", 1)]);
    expect(tally.JOHNSON.ratio).toBeNull();
    const rows = desiredEventAwards(
      { countsForShowUp: true, countsForRepYourHouse: true, isHouseCompetition: false, competitionWinners: [] },
      tally,
    );
    expect(rows.some((r) => r.house === "JOHNSON")).toBe(false);
    expect(rows.find((r) => r.house === "JEMISON" && r.category === "REP_YOUR_HOUSE")!.points).toBe(1);
    // ...and every input row records Johnson as undefined, not 0.
    const inputs = rows.find((r) => r.category === "REP_YOUR_HOUSE")!.inputs as Array<{ house: string; percentage: number | null }>;
    expect(inputs.find((i) => i.house === "JOHNSON")!.percentage).toBeNull();
  });
});

describe("Own the Month", () => {
  it("averages percentages across events, not pooled attendance", () => {
    // Per-event tallies whose denominators differ, so the two methods disagree:
    //   Jemison: 1/1 and 0/9   → mean of 100% and 0% = 50%  (pooled: 1/10 = 10%)
    //   Latimer: 3/10 and 3/10 → mean 30%                    (pooled: 6/20 = 30%)
    // Averaging picks Jemison; pooling would have picked Latimer.
    const t = (house: "JEMISON" | "LATIMER", n: number, d: number) => ({
      house,
      attendeeIds: Array.from({ length: n }, (_, i) => `${house}-${i}`),
      attendeeCount: n,
      rosterCount: d,
      ratio: fraction(n, d),
    });
    const none = (house: "JOHNSON" | "DEAN") => ({ house, attendeeIds: [], attendeeCount: 0, rosterCount: 0, ratio: null });
    const e1 = { JEMISON: t("JEMISON", 1, 1), LATIMER: t("LATIMER", 3, 10), JOHNSON: none("JOHNSON"), DEAN: none("DEAN") };
    const e2 = { JEMISON: t("JEMISON", 0, 9), LATIMER: t("LATIMER", 3, 10), JOHNSON: none("JOHNSON"), DEAN: none("DEAN") };
    const avgs = monthlyAverages([e1, e2]);
    expect(percentageOf(avgs.JEMISON.average!)).toBe(50);
    expect(percentageOf(avgs.LATIMER.average!)).toBe(30);
    expect(ownTheMonthWinners(avgs)).toEqual(["JEMISON"]);
  });

  it("a three-way monthly tie awards 2 points to each", () => {
    const roster = rosterOf({ Johnson: 4, Jemison: 2, Latimer: 8, Dean: 4 });
    const e1 = tallyEvent(roster, [...attend("Johnson", 2), ...attend("Jemison", 1), ...attend("Latimer", 4), ...attend("Dean", 1)]);
    expect(ownTheMonthWinners(monthlyAverages([e1])).sort()).toEqual(["JEMISON", "JOHNSON", "LATIMER"]);
  });

  it("a House with no eligible events in the month has no average and is excluded", () => {
    const roster = rosterOf({ Jemison: 2 });
    const avgs = monthlyAverages([tallyEvent(roster, attend("Jemison", 1))]);
    expect(avgs.DEAN.average).toBeNull();
    expect(avgs.DEAN.eventCount).toBe(0);
    expect(monthlyAverages([]).JEMISON.average).toBeNull();
    expect(ownTheMonthWinners(monthlyAverages([]))).toEqual([]);
  });
});

describe("who counts toward a House", () => {
  it("members with no House or an unverified House are excluded from both numerator and denominator", () => {
    const roster = buildRoster([
      member("a", "Jemison"),
      member("b", "Jemison"),
      member("no-house", null),
      member("unverified", "Jemison", { houseVerifiedAt: null }),
      member("unknown-house", "Hogwarts"),
    ]);
    expect(roster.JEMISON.size).toBe(2);
    const tally = tallyEvent(roster, ["a", "no-house", "unverified", "unknown-house"]);
    expect(tally.JEMISON).toMatchObject({ attendeeCount: 1, rosterCount: 2, attendeeIds: ["a"] });
  });

  it("a trashed member is excluded from both", () => {
    const roster = buildRoster([member("a", "Dean"), member("trashed", "Dean", { deletedAt: new Date() })]);
    const tally = tallyEvent(roster, ["a", "trashed"]);
    expect(tally.DEAN).toMatchObject({ attendeeCount: 1, rosterCount: 1 });
  });

  it("E-Board, admins and guests are excluded from both — attendance is expected of officers", () => {
    for (const role of ["eboard", "admin", "guest"] as const) {
      expect(houseForRoster(member("x", "Latimer", { role }))).toBeNull();
    }
    expect(houseForRoster(member("x", "Latimer", { suspended: true }))).toBeNull();
    expect(houseForRoster(member("x", "Latimer"))).toBe("LATIMER");
  });

  it("each member counts once per event", () => {
    const tally = tallyEvent(buildRoster([member("a", "Dean"), member("b", "Dean")]), ["a", "a", "a"]);
    expect(tally.DEAN.attendeeCount).toBe(1);
  });

  it("maps User.house display names onto the four Houses", () => {
    expect(houseFromUserValue("Jemison")).toBe("JEMISON");
    expect(houseFromUserValue(" johnson ")).toBe("JOHNSON");
    expect(houseFromUserValue("")).toBeNull();
    expect(houseFromUserValue(null)).toBeNull();
    expect(houseFromUserValue("Gryffindor")).toBeNull();
  });
});

describe("percentages are rounded for display only", () => {
  it("stores 4 decimal places", () => {
    expect(percentageOf(fraction(1, 3))).toBe(33.3333);
    expect(percentageOf(fraction(2, 3))).toBe(66.6667);
    expect(percentageOf(fraction(0, 5))).toBe(0);
  });
});

describe("the House leaderboard", () => {
  it("sums rows, skips revoked ones, and ranks with standard competition ranking", () => {
    const totals = houseTotals([
      { house: "JEMISON", category: "SHOW_UP", points: 2, revokedAt: null },
      { house: "JEMISON", category: "MANUAL", points: 3, revokedAt: null },
      { house: "LATIMER", category: "OWN_THE_MONTH", points: 2, revokedAt: null },
      { house: "LATIMER", category: "WIN", points: 3, revokedAt: null },
      { house: "DEAN", category: "SHOW_UP", points: 9, revokedAt: new Date() },
      { house: "JOHNSON", category: "MANUAL", points: -1, revokedAt: null },
    ]);
    expect(totals.map((t) => [t.house, t.total, t.rank])).toEqual([
      ["JEMISON", 5, 1],
      ["LATIMER", 5, 1],
      ["DEAN", 0, 3],
      ["JOHNSON", -1, 4],
    ]);
    expect(totals[0].byCategory).toMatchObject({ SHOW_UP: 2, MANUAL: 3 });
  });
});
