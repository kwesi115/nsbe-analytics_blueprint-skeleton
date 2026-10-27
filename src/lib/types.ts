/**
 * Pure domain types. These are the shapes lib/repo.ts returns — never raw
 * Prisma rows — and the only shapes lib/points.ts, lib/code.ts, and
 * lib/forms.ts know about. Prisma's generated enums/models are mapped to
 * these at the repo.ts boundary; nothing outside repo.ts should import from
 * src/generated/prisma directly.
 */

export type Role = "admin" | "eboard" | "general" | "guest";

/** A narrow, revocable capability grantable to one member independent of role — see lib/permissions.ts and prisma/schema.prisma's PermissionGrant. */
export type PermissionName = "verifications_write" | "attendance_write" | "points_write" | "files_read" | "houses_write";

/**
 * WHY a caller was turned away from an admin surface — the shape lib/access.ts
 * builds, AppError carries, and admin/_components/AccessDenied.tsx renders copy
 * for. Deliberately a discriminated union rather than a bare boolean: the page
 * has to be able to say WHICH requirement was missed ("requires the Membership
 * audit permission") instead of a generic "admin-only", which is the whole
 * point of Part 2.
 *
 * "feature" is not a permission failure at all — the surface exists and the
 * caller may well be allowed to use it, but it is switched off org-wide by a
 * Config flag (see lib/features.ts). It renders the same calm page because to
 * the person clicking, the outcome is identical: this isn't for you right now.
 */
export type Denial =
  | { kind: "admin" }
  | { kind: "eboard" }
  | { kind: "permission"; permission: PermissionName }
  | { kind: "feature"; feature: FeatureName };

/** An org-wide on/off switch stored in Config and toggled from /admin/settings — see lib/features.ts. */
export type FeatureName = "exports";

export type ShirtSize = "S" | "M" | "L" | "XL";

/** EBOARD_ONLY events never appear in the member feed or member leaderboard — see lib/points.ts eboardAwardFor. */
export type Audience = "all" | "eboard_only";

export type Classification = "freshman" | "sophomore" | "junior" | "senior" | "graduate";

export type FileKind = "resume" | "house_proof";

export type GroupKind = "nsbe_week";

/** "adjustment" is the only kind whose points may be negative — see lib/repo.ts createPointAdjustment. */
export type AwardKind = "game_competition" | "monthly_champion" | "manual" | "adjustment";

// No "live"/"closed" — whether an event is open is derived from the clock (see lib/points.ts isOpen).
export type EventStatus = "draft" | "scheduled" | "canceled";

export type FieldType =
  | "short_text"
  | "long_text"
  | "select"
  | "multi_select"
  | "number"
  | "yes_no"
  | "rating"
  | "date";

/** Signup/approval lifecycle — orthogonal to Role. See lib/signup.ts. */
export type UserStatus = "pending" | "active" | "suspended";

export interface Member {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  studentId: string;
  classification: Classification | "";
  major: string;
  majorOther: string;
  membership: string;
  phone: string;
  personalEmail: string;
  tshirtSize: ShirtSize | "";
  role: Role;
  status: UserStatus;
  joinedAt: Date | null;

  /** Displayed on the internal E-Board leaderboard only. Meaningful only when role === "eboard". */
  eboardPosition: string;

  // Four distinct states, never three — see lib/claim-state.ts claimState,
  // which is the only thing allowed to interpret this group of fields.
  // duesPaidReported is what the MEMBER said; duesVerifiedAt is what an
  // ADMIN checked. They are not interchangeable and must never render the
  // same glyph.
  duesPaidReported: boolean | null;
  duesReportedAt: Date | null;
  duesVerifiedAt: Date | null;
  duesVerifiedById: string;
  duesRevokedAt: Date | null;
  duesRevokedById: string;
  duesRevokedNote: string;

  nationalMemberReported: boolean | null;
  nsbeMembershipId: string;
  nationalVerifiedAt: Date | null;
  nationalVerifiedById: string;
  nationalRevokedAt: Date | null;
  nationalRevokedById: string;
  nationalRevokedNote: string;

  /** The season (Config.SEASON) dues/national were last confirmed for — see lib/points.ts isEligible. */
  membershipSeason: string;

  /** The season (Config.SEASON) classification/major were last confirmed for — see lib/core-form.ts getMissingFields. */
  profileSeason: string;

  house: string;
  houseVerifiedAt: Date | null;
  /** A User id, or the literal HOUSE_SYSTEM_VERIFIER for an E-Board House verified on selection. */
  houseVerifiedById: string;
  houseProofFileId: string | null;

  resumeFileId: string | null;
  resumeUpdatedAt: Date | null;
  resumeConsentAt: Date | null;

  /** Set when the signup wizard finished; null while the account is still mid-signup. See lib/signup.ts. */
  signupCompletedAt: Date | null;
}

export interface UploadedFile {
  id: string;
  userId: string;
  kind: FileKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date | null;
}

/**
 * The credential-bearing half of a User row. Only repo.getAuthRecord()
 * returns this — never mix it into Member/getMembers()/getMember(), and
 * never let it reach a response body, a session, or the admin export.
 * At most one of passwordHash / setupCode is set (a database CHECK enforces
 * it) — see prisma/schema.prisma model User and lib/credentials.ts.
 */
export interface AuthRecord {
  email: string;
  /** Null while a setup code is pending, and for a GUEST row created by registerGuest(). */
  passwordHash: string | null;
  /** The pending setup code, SEALED (lib/setup-code.ts) — never plaintext. Null once a real password is set. */
  setupCode: string | null;
  role: Role;
  mustChangePassword: boolean;
  status: UserStatus;
  /**
   * Whether signup is finished, as lib/signup.ts signupIsComplete defines it —
   * the LATCH OR an already-complete profile, never just the column.
   *
   * The verdict rather than the raw timestamp, deliberately: the member layout
   * and /join/resume redirect on opposite answers to this question, so if one of
   * them re-derived it even slightly differently the two would bounce a member
   * between them forever. Exposing the answer instead of the input makes that
   * mistake impossible to make. Carried on the record the session callback
   * already reads on every auth() call, so the gate costs no extra query.
   */
  signupComplete: boolean;
}

/**
 * What a session needs, and nothing else.
 *
 * DELIBERATELY NOT AuthRecord. The session callback used to call
 * repo.getAuthRecord() for two non-credential flags (mustChangePassword and
 * the signup verdict) that happened to live only on that record — and paid
 * for them by selecting the whole User row, passwordHash and setupCode
 * included. That coupling is what turned an unrelated column being absent
 * from the database into a total auth outage: every auth() call runs the
 * session callback, so a SELECT that named a missing column threw on every
 * page, the public sign-in page among them.
 *
 * This record is the fix. repo.getSessionUser() names its columns explicitly,
 * so the session query can only ever break on a column the session actually
 * uses, and no credential material is in reach of the session path at all.
 * AuthRecord stays what it always was: the credentials authorize() path only.
 */
export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  orgId: string;
  mustChangePassword: boolean;
  /**
   * The signup LATCH, raw. Null means mid-signup.
   *
   * The raw column rather than signupIsComplete's verdict, because the
   * verdict needs the whole profile and this query deliberately reads seven
   * columns. The two consumers stay in agreement anyway — see
   * (public)/join/resume/page.tsx, which latches a row the predicate already
   * considers finished instead of bouncing it back.
   */
  signupCompletedAt: Date | null;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  logoUrl: string;
  primaryColor: string;
  active: boolean;
}

export interface JoinCodeSummary {
  id: string;
  label: string;
  grantsRole: Role;
  codeHint: string;
  active: boolean;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  createdAt: Date | null;
  rotatedAt: Date | null;
}

/** Replaces the old flat PointSystem map — see lib/points.ts memberPointsFor/eboardAwardFor. */
export interface EventCategory {
  id: string;
  code: string;
  name: string;
  shortName: string;
  /** null for non-tiered categories (NSBE Week, E-Board meeting/retreat). */
  tier: number | null;
  memberPoints: number;
  examples: string;
  countsForMonthly: boolean;
  eboardEligible: boolean;
  audience: Audience;
  active: boolean;
  sortOrder: number;
}

export interface BonusTier {
  min: number;
  max: number | null;
  bonus: number;
}

/** An NSBE-Week-shaped set of events — see lib/points.ts groupBonusFor. */
export interface EventGroup {
  id: string;
  name: string;
  slug: string;
  kind: GroupKind;
  expectedEventCount: number;
  bonusTiers: BonusTier[];
  eventIds: string[];
  finalizedAt: Date | null;
  finalizedById: string;
  createdAt: Date | null;
}

export interface PointAward {
  id: string;
  email: string;
  kind: AwardKind;
  points: number;
  eventId: string | null;
  /** "2026-09" — set only for MONTHLY_CHAMPION. */
  periodMonth: string | null;
  reason: string;
  awardedById: string;
  awardedAt: Date | null;
  revokedAt: Date | null;
  revokedById: string;
  revokeNote: string;
  /** Config.SEASON at creation — set only for "adjustment", which counts only while it matches the current season (see lib/points.ts awardCountsForSeason). */
  season: string | null;
  /** The event an "adjustment" relates to, if any. Informational only — never part of any count. */
  relatedEventId: string | null;
}

export interface Event {
  eventId: string;
  /** Human-readable, unique — used for export sheet/file names. Never used for routing. */
  slug: string;
  name: string;
  categoryId: string;
  /** Embedded snapshot of the live category row — see lib/repo.ts eventToDomain. Always the CURRENT category values, never frozen at creation time. */
  category: EventCategory;
  /** The NSBE-Week-style set this event belongs to, if any. */
  groupId: string | null;
  date: Date | null;
  location: string;
  description: string;
  /** Explicit override for this event's point value. null = fall back to category.memberPoints. A 0 override is distinct from null. */
  points: number | null;
  status: EventStatus;
  opensAt: Date | null;
  closesAt: Date | null;
  durationMinutes: number | null;
  openedBy: string;
  openedAt: Date | null;
  createdBy: string;
  createdAt: Date | null;
  audience: Audience;
  /** House Scoring settings — see lib/house-repo.ts. Optional only so hand-built test fixtures needn't carry it; lib/repo.ts eventToDomain always sets it. */
  house?: EventHouseSettings;
}

export interface EventHouseSettings {
  countsForShowUp: boolean;
  countsForRepYourHouse: boolean;
  countsForMonthlyHouse: boolean;
  isHouseCompetition: boolean;
  /** "JOHNSON" | "JEMISON" | "LATIMER" | "DEAN" — see lib/house-scoring.ts HOUSE_CODES. */
  competitionWinners: string[];
  houseScoredAt: Date | null;
}

export interface FormField {
  eventId: string;
  fieldKey: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  helpText: string;
  order: number;
  prefill: string;
}

export interface AttendanceRecord {
  id: string;
  timestamp: Date | null;
  eventId: string;
  email: string;
  /** The role frozen at submit time — NOT authoritative for standings, see computeStandings. */
  role: Role;
  /** Historical snapshot of what memberPointsFor produced at check-in time — audit/display only. NOT read by computeStandings, which re-derives from the live category/override so a later point-value edit changes derived totals with no backfill. */
  pointsAwarded: number;
  source: string;
  note: string;
  /** The event's live pointsOverride — see lib/points.ts memberPointsFor. */
  eventPointsOverride: number | null;
  /** The event's live closesAt — needed to bucket a registration into a calendar month for the Monthly Engagement Champion. */
  closesAt: Date | null;
  category: Pick<EventCategory, "memberPoints" | "eboardEligible" | "countsForMonthly">;
}

/**
 * eventPoints/nsbeWeekBonus/gameBonus/monthlyChampionBonus/manualBonus/adjustments
 * sum to total — see lib/points.ts memberTotal. adjustments may be negative, and
 * so may total: this is the TRUE value. Member-facing surfaces render
 * displayTotal(total) instead (see lib/points.ts), admin surfaces render total.
 */
export interface PointBreakdown {
  eventPoints: number;
  nsbeWeekBonus: number;
  gameBonus: number;
  monthlyChampionBonus: number;
  manualBonus: number;
  adjustments: number;
  total: number;
}

export interface Standing {
  email: string;
  firstName: string;
  lastName: string;
  points: number;
  events: number;
  rank: number;
}

export interface MemberSummary {
  email: string;
  points: number;
  events: number;
  rank: number | null;
  totalRanked: number;
}

export interface AdminLogEntry {
  timestamp: Date | null;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

/** Derived account state for the members table — never stored as a column. */
export type AccountState = "active" | "setup_pending" | "reset_pending";
