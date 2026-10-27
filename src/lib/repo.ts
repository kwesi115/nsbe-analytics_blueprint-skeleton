/**
 * Typed accessors over Postgres (via Prisma). This is the ONLY module the
 * rest of the app should import for data access — it returns domain types
 * (lib/types.ts), never raw Prisma rows, and maps Prisma's enums to/from the
 * lowercase domain enums at this boundary so lib/points.ts, lib/code.ts, and
 * lib/forms.ts never see a Prisma type.
 *
 * Multi-tenancy: every exported function below that touches an org-scoped
 * model (User, Event, EventCategory, EventGroup, PointAward, Config, AdminLog, UploadedFile, JoinCode)
 * takes `orgId` as a required, non-defaulted first parameter — there is no
 * fallback org, so a call site that doesn't have one is a compile error, not
 * a silent cross-org query. Functions keyed by an id on a model that has no
 * orgId column of its own (FormField, Registration, Answer) still take
 * orgId and filter through the owning Event's `orgId` relation in the same
 * query, so a caller can never read/write another org's rows by guessing an
 * id. The only functions exempt from this are pure predicates/helpers with no
 * database access (canAccessFile, slugify) and org-lookup functions
 * (getOrgBySlug, getActiveOrgs) — those two are how a caller gets an orgId in
 * the first place, so they can't require one themselves.
 */

import { revalidateTag } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { normalizeEmail } from "@/lib/email";
import {
  Audience as DbAudience,
  AwardKind as DbAwardKind,
  Classification as DbClassification,
  FieldType as DbFieldType,
  EventStatus as DbEventStatus,
  FileKind as DbFileKind,
  GroupKind as DbGroupKind,
  Permission as DbPermission,
  RegistrationSource as DbSource,
  Role as DbRole,
  ShirtSize as DbShirtSize,
  UserStatus as DbUserStatus,
} from "@/generated/prisma/enums";
import type {
  AdminLogModel,
  EventCategoryModel,
  EventGroupModel,
  EventModel,
  FormFieldModel,
  JoinCodeModel,
  OrgModel,
  PointAwardModel,
  RegistrationModel,
  UploadedFileModel,
  UserModel,
} from "@/generated/prisma/models";
import { verifyCode } from "./code";
import { AppError } from "./errors";
import { claimState, type ClaimState } from "./claim-state";
import { CORE_FORM_VERSION, houseSelfVerifies, planCheckIn, validateCoreAnswers, type CoreFormAnswers } from "./core-form";
import { logCheckInRejection, logRequiredButNotRendered } from "./checkin-diagnostics";
import { missingSignupSteps, signupIsComplete, type StepKey } from "./signup";
import { validateAnswers, serializeAnswers } from "./forms";
import { formatMonthKey, formatSigned, memberDisplayName } from "./format";
import { parseHouses, type House } from "./houses";
import {
  getCalculatedHouseMonths,
  getHouseAwardsForEvent,
  hasHouseFlags,
  houseMonthWarningFor,
  onHouseAttendanceChanged,
  processEventHouseScoring,
} from "./house-repo";
import { generateSetupCode, hashPassword, verifyPassword } from "./passwords";
import { openSetupCode, sealSetupCode } from "./setup-code";
import { hashIp, isEventCodeLocked, recordEventCodeFailure } from "./rate-limit";
import {
  awardCountsForSeason,
  computeEboardStandings,
  computeStandings,
  computeStandingsWithBreakdowns,
  eboardAwardFor,
  groupBonusFor,
  isEboardOrAdmin,
  isEligible,
  isGroupComplete,
  isOpen,
  isMonthOver,
  memberPointsFor,
  memberTotal,
  monthKeyOf,
  monthlyChampions,
  projectStandings,
  rankWithLiveSelf,
  standingsCacheTag,
  summaryFor,
  type EboardStandingsConfig,
  type GroupBonusInput,
} from "./points";
import { prisma } from "./prisma";
import { backupStorage, backupStorageStatus, storage, type BackupStorageStatus } from "./storage";
import type {
  AccountState,
  AdminLogEntry,
  AttendanceRecord,
  Audience,
  AuthRecord,
  AwardKind,
  BonusTier,
  Classification,
  Event,
  EventCategory,
  EventGroup,
  EventStatus,
  FieldType,
  FileKind,
  FormField,
  GroupKind,
  JoinCodeSummary,
  Member,
  MemberSummary,
  Org,
  PermissionName,
  PointAward,
  PointBreakdown,
  Role,
  SessionUser,
  ShirtSize,
  Standing,
  UploadedFile,
  UserStatus,
} from "./types";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// The trash bin's read filter.
//
// A trashed User or Event (deletedAt set — see prisma/schema.prisma) is hidden
// from EVERY read in this module unless the caller passes `includeDeleted`,
// which only the trash views and the purge path do. The filter is written out
// at each query rather than applied by a Prisma extension, so a reader can see
// it — and so a query that deliberately skips it has to say why in a comment.
//
// The part that is easy to miss: Registration has no deletedAt of its own.
// A trashed event's registrations are KEPT (restoring the event restores every
// count exactly), so any read over Registration must join to Event and filter
// there — liveRegistrationWhere below — or a trashed event keeps counting.
// ---------------------------------------------------------------------------

/** Spread into any User or Event `where`. */
const LIVE = { deletedAt: null } as const;

/** Options for the few reads that the trash views need to see past the filter. */
export interface IncludeDeleted {
  includeDeleted?: boolean;
}

/**
 * A registration counts only when its EVENT is live and its MEMBER is live.
 * `includeTrashedMembers` drops the second half for the one read that wants it
 * (the Monthly Champion calculation — see calculateMonthlyChampions); nothing
 * ever drops the first.
 */
function liveRegistrationWhere(orgId: string, options: { includeTrashedMembers?: boolean } = {}): Prisma.RegistrationWhereInput {
  return {
    event: { orgId, ...LIVE },
    ...(options.includeTrashedMembers ? {} : { user: LIVE }),
  };
}

/**
 * An award counts only while its member is live and, for an award tied to an
 * event (a game bonus), while that event is live too — trashing an event
 * removes everything that event contributed. An adjustment's relatedEventId is
 * informational and deliberately NOT part of this: an adjustment is a
 * correction about the member, and stays in force when a related event is
 * trashed.
 */
function liveAwardWhere(orgId: string): Prisma.PointAwardWhereInput {
  return { orgId, user: LIVE, OR: [{ eventId: null }, { event: LIVE }] };
}

/**
 * tx.user.update for a write that must not land on a trashed account: the
 * caller spreads LIVE into its unique `where`, and a trashed (or missing) row
 * becomes NOT_FOUND rather than an unhandled P2025. Server actions already
 * resolve their target through a filtered read, so this is the backstop for a
 * crafted request naming a trashed member's email directly.
 */
function updateLiveUser(tx: Tx, args: Prisma.UserUpdateArgs): Promise<UserModel> {
  return orNotFound(tx.user.update(args) as Promise<UserModel>, "Member not found");
}

/** Maps Prisma's "record to update not found" (a trashed or missing row under a LIVE-filtered unique where) to the NOT_FOUND every caller already handles. */
async function orNotFound<T>(work: Promise<T>, message: string): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new AppError("NOT_FOUND", message);
    }
    throw err;
  }
}

const MAX_EXTRA_QUESTIONS_HARD_CAP = 5;

// ---------------------------------------------------------------------------
// Enum mapping — the only place lowercase domain enums meet Prisma's enums.
// ---------------------------------------------------------------------------

function roleFromDb(r: DbRole): Role {
  if (r === DbRole.ADMIN) return "admin";
  if (r === DbRole.EBOARD) return "eboard";
  if (r === DbRole.GUEST) return "guest";
  return "general";
}

function roleToDb(r: Role): DbRole {
  if (r === "admin") return DbRole.ADMIN;
  if (r === "eboard") return DbRole.EBOARD;
  if (r === "guest") return DbRole.GUEST;
  return DbRole.GENERAL;
}

function permissionToDb(p: PermissionName): DbPermission {
  switch (p) {
    case "verifications_write":
      return DbPermission.VERIFICATIONS_WRITE;
    case "attendance_write":
      return DbPermission.ATTENDANCE_WRITE;
    case "points_write":
      return DbPermission.POINTS_WRITE;
    case "files_read":
      return DbPermission.FILES_READ;
    case "houses_write":
      return DbPermission.HOUSES_WRITE;
  }
}

function permissionFromDb(p: DbPermission): PermissionName {
  switch (p) {
    case DbPermission.ATTENDANCE_WRITE:
      return "attendance_write";
    case DbPermission.VERIFICATIONS_WRITE:
      return "verifications_write";
    case DbPermission.POINTS_WRITE:
      return "points_write";
    case DbPermission.FILES_READ:
      return "files_read";
    case DbPermission.HOUSES_WRITE:
      return "houses_write";
  }
}

function classificationFromDb(c: DbClassification | null): Classification | "" {
  switch (c) {
    case DbClassification.FRESHMAN:
      return "freshman";
    case DbClassification.SOPHOMORE:
      return "sophomore";
    case DbClassification.JUNIOR:
      return "junior";
    case DbClassification.SENIOR:
      return "senior";
    case DbClassification.GRADUATE:
      return "graduate";
    default:
      return "";
  }
}

function classificationToDb(c: Classification): DbClassification {
  switch (c) {
    case "freshman":
      return DbClassification.FRESHMAN;
    case "sophomore":
      return DbClassification.SOPHOMORE;
    case "junior":
      return DbClassification.JUNIOR;
    case "senior":
      return DbClassification.SENIOR;
    case "graduate":
      return DbClassification.GRADUATE;
  }
}

function shirtSizeFromDb(s: DbShirtSize | null): ShirtSize | "" {
  return s ?? "";
}

function shirtSizeToDb(s: ShirtSize): DbShirtSize {
  return s as DbShirtSize;
}

function fileKindFromDb(k: DbFileKind): FileKind {
  return k === DbFileKind.RESUME ? "resume" : "house_proof";
}

function fileKindToDb(k: FileKind): DbFileKind {
  return k === "resume" ? DbFileKind.RESUME : DbFileKind.HOUSE_PROOF;
}

/** Only one value exists today (GroupKind is extensible per the schema comment) — a real mapping table once a second kind is added. */
function groupKindFromDb(_k: DbGroupKind): GroupKind {
  return "nsbe_week";
}

function groupKindToDb(_k: GroupKind): DbGroupKind {
  return DbGroupKind.NSBE_WEEK;
}

function awardKindFromDb(k: DbAwardKind): AwardKind {
  if (k === DbAwardKind.GAME_COMPETITION) return "game_competition";
  if (k === DbAwardKind.MONTHLY_CHAMPION) return "monthly_champion";
  if (k === DbAwardKind.ADJUSTMENT) return "adjustment";
  return "manual";
}

function statusFromDb(s: DbUserStatus): UserStatus {
  if (s === DbUserStatus.ACTIVE) return "active";
  if (s === DbUserStatus.SUSPENDED) return "suspended";
  return "pending";
}

function statusToDb(s: UserStatus): DbUserStatus {
  if (s === "active") return DbUserStatus.ACTIVE;
  if (s === "suspended") return DbUserStatus.SUSPENDED;
  return DbUserStatus.PENDING;
}

function audienceFromDb(a: DbAudience): Audience {
  return a === DbAudience.EBOARD_ONLY ? "eboard_only" : "all";
}

function audienceToDb(a: Audience): DbAudience {
  return a === "eboard_only" ? DbAudience.EBOARD_ONLY : DbAudience.ALL;
}

function eventStatusFromDb(s: DbEventStatus): EventStatus {
  if (s === DbEventStatus.SCHEDULED) return "scheduled";
  if (s === DbEventStatus.CANCELED) return "canceled";
  return "draft";
}

const FIELD_TYPE_FROM_DB: Record<DbFieldType, FieldType> = {
  SHORT_TEXT: "short_text",
  LONG_TEXT: "long_text",
  SELECT: "select",
  MULTI_SELECT: "multi_select",
  NUMBER: "number",
  YES_NO: "yes_no",
  RATING: "rating",
  DATE: "date",
};
const FIELD_TYPE_TO_DB: Record<FieldType, DbFieldType> = {
  short_text: DbFieldType.SHORT_TEXT,
  long_text: DbFieldType.LONG_TEXT,
  select: DbFieldType.SELECT,
  multi_select: DbFieldType.MULTI_SELECT,
  number: DbFieldType.NUMBER,
  yes_no: DbFieldType.YES_NO,
  rating: DbFieldType.RATING,
  date: DbFieldType.DATE,
};

/** MANUAL -> "manual" is the only value any component checks for exactly; FORM -> "form" is otherwise just display text. */
function sourceFromDb(s: DbSource): string {
  return s === DbSource.MANUAL ? "manual" : "form";
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

function userToMember(u: UserModel): Member {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    studentId: u.studentId ?? "",
    classification: classificationFromDb(u.classification),
    major: u.major ?? "",
    majorOther: u.majorOther ?? "",
    membership: u.membership ?? "",
    phone: u.phone ?? "",
    personalEmail: u.personalEmail ?? "",
    tshirtSize: shirtSizeFromDb(u.tshirtSize),
    role: roleFromDb(u.role),
    status: statusFromDb(u.status),
    joinedAt: u.createdAt,

    eboardPosition: u.eboardPosition ?? "",

    duesPaidReported: u.duesPaidReported,
    duesReportedAt: u.duesReportedAt,
    duesVerifiedAt: u.duesVerifiedAt,
    duesVerifiedById: u.duesVerifiedById ?? "",
    duesRevokedAt: u.duesRevokedAt,
    duesRevokedById: u.duesRevokedById ?? "",
    duesRevokedNote: u.duesRevokedNote ?? "",

    nationalMemberReported: u.nationalMemberReported,
    nsbeMembershipId: u.nsbeMembershipId ?? "",
    nationalVerifiedAt: u.nationalVerifiedAt,
    nationalVerifiedById: u.nationalVerifiedById ?? "",
    nationalRevokedAt: u.nationalRevokedAt,
    nationalRevokedById: u.nationalRevokedById ?? "",
    nationalRevokedNote: u.nationalRevokedNote ?? "",

    membershipSeason: u.membershipSeason ?? "",
    profileSeason: u.profileSeason ?? "",

    house: u.house ?? "",
    houseVerifiedAt: u.houseVerifiedAt,
    houseVerifiedById: u.houseVerifiedById ?? "",
    houseProofFileId: u.houseProofFileId,

    resumeFileId: u.resumeFileId,
    resumeUpdatedAt: u.resumeUpdatedAt,
    resumeConsentAt: u.resumeConsentAt,
    signupCompletedAt: u.signupCompletedAt,
  };
}

function uploadedFileToDomain(f: UploadedFileModel): UploadedFile {
  return {
    id: f.id,
    userId: f.userId,
    kind: fileKindFromDb(f.kind),
    originalName: f.originalName,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    createdAt: f.createdAt,
  };
}

function userToAuthRecord(u: UserModel): AuthRecord {
  return {
    email: u.email,
    passwordHash: u.passwordHash,
    role: roleFromDb(u.role),
    setupCode: u.setupCode,
    mustChangePassword: u.mustChangePassword,
    status: statusFromDb(u.status),
    // The verdict, computed once here from the whole row — see AuthRecord.
    signupComplete: signupIsComplete(userToMember(u)),
  };
}

function orgToDomain(o: OrgModel): Org {
  return {
    id: o.id,
    slug: o.slug,
    name: o.name,
    shortName: o.shortName,
    logoUrl: o.logoUrl ?? "",
    primaryColor: o.primaryColor ?? "",
    active: o.active,
  };
}

function joinCodeToSummary(j: JoinCodeModel): JoinCodeSummary {
  return {
    id: j.id,
    label: j.label,
    grantsRole: roleFromDb(j.grantsRole),
    codeHint: j.codeHint,
    active: j.active,
    expiresAt: j.expiresAt,
    maxUses: j.maxUses,
    useCount: j.useCount,
    createdAt: j.createdAt,
    rotatedAt: j.rotatedAt,
  };
}

/** Every Event query in this module includes its category — see EVENT_INCLUDE below — so eventToDomain always has a live snapshot to embed. */
const EVENT_INCLUDE = { category: true } as const;

function eventCategoryToDomain(c: EventCategoryModel): EventCategory {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    shortName: c.shortName,
    tier: c.tier,
    memberPoints: c.memberPoints,
    examples: c.examples ?? "",
    countsForMonthly: c.countsForMonthly,
    eboardEligible: c.eboardEligible,
    audience: audienceFromDb(c.audience),
    active: c.active,
    sortOrder: c.sortOrder,
  };
}

function eventGroupToDomain(g: EventGroupModel & { events?: Array<{ id: string }> }): EventGroup {
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    kind: groupKindFromDb(g.kind),
    expectedEventCount: g.expectedEventCount,
    bonusTiers: (g.bonusTiers as unknown as BonusTier[] | null) ?? [],
    eventIds: (g.events ?? []).map((e) => e.id),
    finalizedAt: g.finalizedAt,
    finalizedById: g.finalizedById ?? "",
    createdAt: g.createdAt,
  };
}

function pointAwardToDomain(a: PointAwardModel & { user: { email: string } }): PointAward {
  return {
    id: a.id,
    email: a.user.email,
    kind: awardKindFromDb(a.kind),
    points: a.points,
    eventId: a.eventId,
    periodMonth: a.periodMonth,
    reason: a.reason,
    awardedById: a.awardedById ?? "",
    awardedAt: a.awardedAt,
    revokedAt: a.revokedAt,
    revokedById: a.revokedById ?? "",
    revokeNote: a.revokeNote ?? "",
    season: a.season,
    relatedEventId: a.relatedEventId,
  };
}

function eventToDomain(e: EventModel & { category: EventCategoryModel }): Event {
  return {
    eventId: e.id,
    slug: e.slug,
    name: e.name,
    categoryId: e.categoryId,
    category: eventCategoryToDomain(e.category),
    groupId: e.groupId,
    date: e.date,
    location: e.location ?? "",
    description: e.description ?? "",
    points: e.pointsOverride,
    status: eventStatusFromDb(e.status),
    opensAt: e.opensAt,
    closesAt: e.closesAt,
    durationMinutes: e.durationMinutes,
    openedBy: e.openedById ?? "",
    openedAt: e.openedAt,
    createdBy: e.createdById ?? "",
    createdAt: e.createdAt,
    audience: audienceFromDb(e.audience),
    house: {
      countsForShowUp: e.countsForShowUp,
      countsForRepYourHouse: e.countsForRepYourHouse,
      countsForMonthlyHouse: e.countsForMonthlyHouse,
      isHouseCompetition: e.isHouseCompetition,
      competitionWinners: e.competitionWinners,
      houseScoredAt: e.houseScoredAt,
    },
  };
}

function formFieldToDomain(f: FormFieldModel): FormField {
  return {
    eventId: f.eventId,
    fieldKey: f.fieldKey,
    label: f.label,
    type: FIELD_TYPE_FROM_DB[f.type],
    required: f.required,
    options: f.options,
    helpText: f.helpText ?? "",
    order: f.order,
    prefill: f.prefill ?? "",
  };
}

/** Every Registration query used for AttendanceRecord includes this — see REGISTRATION_ATTENDANCE_INCLUDE below. */
const REGISTRATION_ATTENDANCE_INCLUDE = {
  user: { select: { email: true } },
  event: { select: { pointsOverride: true, closesAt: true, category: true } },
} as const;

function registrationToAttendance(
  r: RegistrationModel & {
    user: { email: string };
    event: { pointsOverride: number | null; closesAt: Date | null; category: EventCategoryModel };
  },
): AttendanceRecord {
  return {
    id: r.id,
    timestamp: r.createdAt,
    eventId: r.eventId,
    email: r.user.email,
    role: roleFromDb(r.roleAtTime),
    pointsAwarded: r.pointsAwarded,
    source: sourceFromDb(r.source),
    note: r.note ?? "",
    eventPointsOverride: r.event.pointsOverride,
    closesAt: r.event.closesAt,
    category: eventCategoryToDomain(r.event.category),
  };
}

function adminLogToDomain(l: AdminLogModel & { actor: { email: string } | null }): AdminLogEntry {
  return {
    timestamp: l.createdAt,
    actor: l.actor?.email ?? "",
    action: l.action,
    target: l.target ?? "",
    detail: l.detail ?? "",
  };
}

/**
 * Appends an audit row inside the caller's own transaction — every admin
 * mutation writes one of these, atomically with the mutation itself, never as
 * a separate best-effort write after the fact.
 */
async function logAdminAction(
  tx: Tx,
  orgId: string,
  entry: { actor: string; action: string; target: string; detail?: string },
): Promise<void> {
  const actorUser = await tx.user.findUnique({
    where: { orgId_email: { orgId, email: normalizeEmail(entry.actor) } },
    select: { id: true },
  });
  await tx.adminLog.create({
    data: {
      orgId,
      actorId: actorUser?.id ?? null,
      action: entry.action,
      target: entry.target,
      detail: entry.detail ?? null,
    },
  });
}

/**
 * logAdminAction, for a caller with no open transaction — the two UX-gate
 * check-in code endpoints (verify-code route.ts, guest verifyGuestEventCodeAction)
 * aren't part of any write transaction, unlike every other AdminLog call site
 * in this file. Same shape, same "actor" resolution (an email string, or a
 * non-human value like "system" that resolves to a null actorId).
 */
export async function logSystemAdminEvent(
  orgId: string,
  entry: { actor: string; action: string; target: string; detail?: string },
): Promise<void> {
  await logAdminAction(prisma, orgId, entry);
}

// ---------------------------------------------------------------------------
// Permission grants — the permissions engine (see prisma/schema.prisma
// PermissionGrant, lib/permissions.ts). A narrow, revocable capability on top
// of role: an ADMIN can grant a single GENERAL member one specific EBOARD-
// gated surface without promoting them. One row per (orgId, userId,
// permission) — granting after a revoke reuses that row rather than
// inserting a second one, so the full grant/revoke history for that
// capability stays on a single row.
// ---------------------------------------------------------------------------

/** True if `email` currently holds `permission` — checked live, never cached, so a revoke takes effect on the very next request (see lib/permissions.ts requireVerificationsWrite, the only caller today). */
export async function hasPermission(orgId: string, email: string, permission: PermissionName): Promise<boolean> {
  const e = normalizeEmail(email);
  const grant = await prisma.permissionGrant.findFirst({
    where: { orgId, permission: permissionToDb(permission), revokedAt: null, user: { orgId, email: e } },
    select: { id: true },
  });
  return grant !== null;
}

/** Every permission `email` currently holds — for an admin-facing display (the member detail page's Permissions panel). */
export async function getActivePermissions(orgId: string, email: string): Promise<PermissionName[]> {
  const e = normalizeEmail(email);
  const grants = await prisma.permissionGrant.findMany({
    where: { orgId, revokedAt: null, user: { orgId, email: e } },
    select: { permission: true },
  });
  return grants.map((g) => permissionFromDb(g.permission));
}

export async function grantPermission(orgId: string, email: string, permission: PermissionName, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  const a = normalizeEmail(actor);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
    if (!user) throw new AppError("NOT_FOUND", "Member not found");
    const actorUser = await tx.user.findUnique({ where: { orgId_email: { orgId, email: a } }, select: { id: true } });

    await tx.permissionGrant.upsert({
      where: { orgId_userId_permission: { orgId, userId: user.id, permission: permissionToDb(permission) } },
      create: { orgId, userId: user.id, permission: permissionToDb(permission), grantedById: actorUser?.id ?? null },
      update: { grantedAt: new Date(), grantedById: actorUser?.id ?? null, revokedAt: null, revokedById: null },
    });
    await logAdminAction(tx, orgId, { actor, action: "grant_permission", target: e, detail: permission });
  });
}

/** Idempotent — revoking a permission that isn't currently held is a no-op, not an error. */
export async function revokePermission(orgId: string, email: string, permission: PermissionName, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  const a = normalizeEmail(actor);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
    if (!user) throw new AppError("NOT_FOUND", "Member not found");
    const existing = await tx.permissionGrant.findUnique({
      where: { orgId_userId_permission: { orgId, userId: user.id, permission: permissionToDb(permission) } },
    });
    if (!existing || existing.revokedAt !== null) return;

    const actorUser = await tx.user.findUnique({ where: { orgId_email: { orgId, email: a } }, select: { id: true } });
    await tx.permissionGrant.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedById: actorUser?.id ?? null },
    });
    await logAdminAction(tx, orgId, { actor, action: "revoke_permission", target: e, detail: permission });
  });
}

/**
 * The per-EVENT half of check-in code verification, shared by all four call
 * sites that ever check a code (the member UX-gate route, the guest UX-gate
 * action, and the two real security boundaries — registerForEvent and
 * registerGuest below). Distinct from the existing per-member/IP limiter
 * (lib/rate-limit.ts assertNotCodeVerifyRateLimited), which callers still
 * check/record themselves where they already did — this only adds the
 * EVENT-wide view a distributed attacker (many accounts) can't route around.
 *
 * Locked: throws EVENT_NOT_OPEN with the same paused-for-check-in message a
 * genuinely closed event would give — never a distinct error, so a
 * distributed attacker can't tell "closed" from "brute-force locked" apart.
 * Bad code: records the failure (per-event counter; an AdminLog "suspected"
 * entry on the first crossing of the soft threshold, never one per attempt)
 * and throws BAD_CODE, same message as always. Good code: returns silently,
 * touching neither limiter.
 */
export async function verifyEventCodeOrThrow(input: {
  orgId: string;
  eventId: string;
  code: string;
  now: Date;
  /** For the structured failure log only — never used as a rate-limit key (callers already keyed the per-member/IP limiter themselves). */
  who: string;
  ip: string;
}): Promise<void> {
  const nowMs = input.now.getTime();
  if (isEventCodeLocked(input.eventId, nowMs)) {
    throw new AppError("EVENT_NOT_OPEN", "Check-in is temporarily paused — see an E-Board member");
  }
  if (verifyCode(input.eventId, input.code, input.now)) return;

  console.warn(
    JSON.stringify({
      event: "code_verify_failed",
      orgId: input.orgId,
      eventId: input.eventId,
      who: input.who,
      ipHash: hashIp(input.ip),
    }),
  );
  const [softRaw, hardRaw] = await Promise.all([
    getConfigValue(input.orgId, "EVENT_CODE_FAIL_SOFT", "100"),
    getConfigValue(input.orgId, "EVENT_CODE_FAIL_HARD", "250"),
  ]);
  const soft = Number(softRaw) || 100;
  const hard = Number(hardRaw) || 250;
  const { crossedSoft } = recordEventCodeFailure(input.eventId, soft, hard, nowMs);
  if (crossedSoft) {
    await logSystemAdminEvent(input.orgId, {
      actor: "system",
      action: "code_brute_force_suspected",
      target: input.eventId,
      detail: `${soft}+ failed check-in code attempts in the last ${EVENT_CODE_FAIL_WINDOW_MINUTES} minutes`,
    });
  }
  throw new AppError("BAD_CODE", "That code isn't right. Check the display and try again.");
}

const EVENT_CODE_FAIL_WINDOW_MINUTES = 10;

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "event"
  );
}

async function uniqueSlug(tx: Tx, orgId: string, base: string, excludeId?: string): Promise<string> {
  let candidate = base;
  let n = 2;
  for (;;) {
    const existing = await tx.event.findUnique({ where: { orgId_slug: { orgId, slug: candidate } }, select: { id: true } });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${n++}`;
  }
}

// ---------------------------------------------------------------------------
// Org lookup — the only two functions in this module that DON'T take an
// orgId, because they're how a caller gets one. See lib/org.ts.
// ---------------------------------------------------------------------------

export async function getOrgBySlug(slug: string): Promise<Org | null> {
  const row = await prisma.org.findUnique({ where: { slug: slug.trim().toLowerCase() } });
  return row ? orgToDomain(row) : null;
}

export async function getOrgById(id: string): Promise<Org | null> {
  const row = await prisma.org.findUnique({ where: { id } });
  return row ? orgToDomain(row) : null;
}

export async function getActiveOrgs(): Promise<Org[]> {
  const rows = await prisma.org.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  return rows.map(orgToDomain);
}

// ---------------------------------------------------------------------------
// Read accessors
// ---------------------------------------------------------------------------

export async function getMembers(orgId: string, options: IncludeDeleted = {}): Promise<Member[]> {
  const users = await prisma.user.findMany({
    where: { orgId, ...(options.includeDeleted ? {} : LIVE) },
    orderBy: { lastName: "asc" },
  });
  return users.map(userToMember);
}

export async function getMember(orgId: string, email: string): Promise<Member | null> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
  return user ? userToMember(user) : null;
}

/** Keyed by the internal id (cuid) — used for /admin/members/[id], consistent with /events/[id]. A trashed member 404s there; the trash bin is where they live until restored. */
export async function getMemberById(orgId: string, id: string): Promise<Member | null> {
  const user = await prisma.user.findFirst({ where: { id, orgId, ...LIVE } });
  return user ? userToMember(user) : null;
}

/** A trashed account reads as "general" — the no-access default — so every requireAdmin/requireEboard re-check refuses it even on a JWT minted before it was trashed. */
export async function getRole(orgId: string, email: string): Promise<Role> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE }, select: { role: true } });
  return user ? roleFromDb(user.role) : "general";
}

/** The internal id behind an email — needed wherever a caller only has a session email but must write a foreign key (e.g. UploadedFile.userId). */
export async function getUserId(orgId: string, email: string): Promise<string | null> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE }, select: { id: true } });
  return user?.id ?? null;
}

/**
 * Everything the NextAuth session callback re-reads on every auth() call, and
 * NOTHING else — see types.ts SessionUser for why this exists separately from
 * getAuthRecord.
 *
 * The explicit `select` is the load-bearing part, not a micro-optimization.
 * getAuthRecord's bare findUnique selects every column of User, so it breaks
 * whenever ANY column in the model is missing from the database; running that
 * in the session callback meant an unrelated migration gap (setupCode) logged
 * every user out of every page, including the public layout that renders
 * /signin. Naming seven columns means the session can only be broken by a
 * column the session itself depends on.
 *
 * Keep this list in step with types/next-auth.d.ts Session["user"]. Adding a
 * column here is adding a column the whole app's authentication depends on:
 * it needs a committed migration before it is deployed.
 */
export async function getSessionUser(orgId: string, email: string): Promise<SessionUser | null> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    // A trashed account has no session: null here makes src/auth.ts's session
    // callback sign the request out, so trashing someone ends a session they
    // already had open, on its very next request.
    where: { orgId_email: { orgId, email: e }, ...LIVE },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      orgId: true,
      mustChangePassword: true,
      signupCompletedAt: true,
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: roleFromDb(user.role),
    status: statusFromDb(user.status),
    orgId: user.orgId,
    mustChangePassword: user.mustChangePassword,
    signupCompletedAt: user.signupCompletedAt,
  };
}

/**
 * The ONLY function that returns passwordHash. Everything else that reads
 * Users (getMembers, getMember, ...) maps through userToMember(), which never
 * touches it.
 *
 * A trashed account returns null — to src/auth.ts authorize() exactly the
 * same as no account at all, so sign-in fails with the generic message and
 * the same dummy bcrypt cost, and never reveals that the account exists but
 * was deleted.
 */
export async function getAuthRecord(orgId: string, email: string): Promise<AuthRecord | null> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
  return user ? userToAuthRecord(user) : null;
}

/** Config.LEADERBOARD_DISCLAIMER's default — shown on /leaderboard and in both the CSV and Excel exports until an E-Board member edits it from /admin/settings. */
export const DEFAULT_LEADERBOARD_DISCLAIMER =
  "Leaderboard standing does not guarantee selection for conferences, but it plays a significant role in the selection process.";

/** Config.NATIONAL_MEMBERSHIP_URL's default — nsbe.org's current membership landing page (join + renew), verified live as of this default's introduction. */
export const DEFAULT_NATIONAL_MEMBERSHIP_URL = "https://nsbe.org/memberships/";

export async function getConfigValue(orgId: string, key: string, fallback = ""): Promise<string> {
  const row = await prisma.config.findUnique({ where: { orgId_key: { orgId, key } } });
  return row?.value ?? fallback;
}

export async function setConfigValue(orgId: string, key: string, value: string, actor: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.config.upsert({
      where: { orgId_key: { orgId, key } },
      update: { value },
      create: { orgId, key, value },
    });
    await logAdminAction(tx, orgId, { actor, action: "update_config", target: key, detail: value });
  });
}

/** Config.ADMIN_EMAIL_ALLOWLIST — pipe-delimited, same convention as MAJORS_LIST (see getCoreFormConfig). */
export async function getAdminEmailAllowlist(orgId: string): Promise<string[]> {
  const raw = await getConfigValue(orgId, "ADMIN_EMAIL_ALLOWLIST", "");
  return raw
    .split("|")
    .map((v) => normalizeEmail(v))
    .filter(Boolean);
}

/**
 * The LOGIN-time domain gate: an email may sign in only if it ends with
 * Config.ALLOWED_EMAIL_DOMAIN OR appears in Config.ADMIN_EMAIL_ALLOWLIST.
 * When no domain is configured there's nothing to gate, so every email
 * passes — same "no restriction configured" behavior as the signup check in
 * (public)/join/actions.ts.
 *
 * Deliberately NOT consulted by signup: the allowlist exists only so the
 * seven pre-seeded ADMIN accounts (prisma/seed.ts seedHardcodedAdmins, all
 * @gmail.com) can sign in — it must never let one of those addresses create a
 * NEW account at /join, since those accounts already exist and are seeded,
 * not self-created. See lib/auth.ts authorize(), the only caller.
 */
export async function isLoginEmailAllowed(orgId: string, email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const [domain, allowlist] = await Promise.all([
    getConfigValue(orgId, "ALLOWED_EMAIL_DOMAIN", ""),
    getAdminEmailAllowlist(orgId),
  ]);
  const d = domain.trim().toLowerCase();
  if (!d) return true;
  return e.endsWith(d) || allowlist.includes(e);
}

export async function getEvents(orgId: string, options: IncludeDeleted = {}): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: { orgId, ...(options.includeDeleted ? {} : LIVE) },
    include: EVENT_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(eventToDomain);
}

/** A trashed event is not found — its member page, check-in, edit and export routes all 404 until it is restored. */
export async function getEvent(orgId: string, eventId: string): Promise<Event | null> {
  const row = await prisma.event.findFirst({ where: { id: eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
  return row ? eventToDomain(row) : null;
}

export async function getOpenEvents(orgId: string, now: Date): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: { orgId, status: DbEventStatus.SCHEDULED, ...LIVE },
    include: EVENT_INCLUDE,
  });
  return rows.map(eventToDomain).filter((e) => isOpen(e, now));
}

/** Open right now, ALL audience only — the guest event feed (Part 5). No EBOARD_ONLY event ever shows here, and no point values are attached to the domain type this returns. */
export async function getOpenGuestEvents(orgId: string, now: Date): Promise<Event[]> {
  return (await getOpenEvents(orgId, now)).filter((e) => e.audience === "all");
}

export async function getFormFields(orgId: string, eventId: string): Promise<FormField[]> {
  const rows = await prisma.formField.findMany({
    where: { eventId, event: { orgId, ...LIVE } },
    orderBy: { order: "asc" },
  });
  return rows.map(formFieldToDomain);
}

/**
 * Single joined query (Registration -> User, Event -> Category) — never one
 * query per row. The attendance log EVERY standings computation reads, so it
 * is where a trashed event stops counting: registrations for a trashed event
 * never leave this function. A trashed member's registrations don't either,
 * unless `includeTrashedMembers` — see liveRegistrationWhere.
 */
export async function getAttendance(
  orgId: string,
  options: { includeTrashedMembers?: boolean } = {},
): Promise<AttendanceRecord[]> {
  const rows = await prisma.registration.findMany({
    where: liveRegistrationWhere(orgId, options),
    include: REGISTRATION_ATTENDANCE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(registrationToAttendance);
}

export async function getAttendanceForEvent(orgId: string, eventId: string): Promise<AttendanceRecord[]> {
  const rows = await prisma.registration.findMany({
    where: { eventId, ...liveRegistrationWhere(orgId) },
    include: REGISTRATION_ATTENDANCE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(registrationToAttendance);
}

/** Every live award (see liveAwardWhere) — revoked ones included, since the awards page lists those too; memberTotal drops them. */
export async function getPointAwards(orgId: string): Promise<PointAward[]> {
  const rows = await prisma.pointAward.findMany({
    where: liveAwardWhere(orgId),
    include: { user: { select: { email: true } } },
    orderBy: { awardedAt: "desc" },
  });
  return rows.map(pointAwardToDomain);
}

/** The include every bonus-math EventGroup read uses: the group's LIVE events only — a trashed event is not part of any group's completion or tier count. */
const GROUP_BONUS_EVENTS = { events: { where: LIVE, select: { id: true, status: true, closesAt: true } } } as const;

/** Every EventGroup query used for bonus math includes this — the group's own events, just enough to decide completion and count attendance. */
async function getGroupBonusInputs(orgId: string): Promise<GroupBonusInput[]> {
  const groups = await prisma.eventGroup.findMany({
    where: { orgId },
    include: GROUP_BONUS_EVENTS,
  });
  return groups.map((g) => ({
    events: g.events.map((e) => ({ eventId: e.id, status: eventStatusFromDb(e.status), closesAt: e.closesAt })),
    bonusTiers: (g.bonusTiers as unknown as BonusTier[] | null) ?? [],
    finalizedAt: g.finalizedAt,
  }));
}

export async function getStandings(orgId: string): Promise<Standing[]> {
  const [attendance, members, season, awards, groups] = await Promise.all([
    getAttendance(orgId),
    getMembers(orgId),
    getConfigValue(orgId, "SEASON", ""),
    getPointAwards(orgId),
    getGroupBonusInputs(orgId),
  ]);
  return computeStandings(attendance, members, season, awards, groups, new Date());
}

/**
 * Same computation as getStandings, but takes `season` as a parameter
 * instead of reading it from Config — used exclusively by
 * lib/standings-cache.ts's getCachedStandings, whose cache key already
 * carries season, so the cached closure must not re-derive it from a second
 * Config read (that would make the cache key and the data it returns
 * disagree on which season was actually queried). Every other caller
 * (getMemberSummary, registerForEvent) keeps using the live, uncached
 * getStandings above.
 */
export async function getStandingsForSeason(orgId: string, season: string): Promise<Standing[]> {
  const [attendance, members, awards, groups] = await Promise.all([
    getAttendance(orgId),
    getMembers(orgId),
    getPointAwards(orgId),
    getGroupBonusInputs(orgId),
  ]);
  return computeStandings(attendance, members, season, awards, groups, new Date());
}

/**
 * Every mutation that can change the standings board (Registration
 * created/deleted, PointAward created/revoked, an EventGroup finalized, a
 * role change, an eligibility change, or a category point-value edit) calls
 * this right after its write commits. Tag format is shared with
 * lib/standings-cache.ts's getCachedStandings via points.ts's
 * standingsCacheTag — the two files never import each other just to agree on
 * a string. `{ expire: 0 }` (not the one-argument form) is required by this
 * Next.js version — see revalidateTag's current signature.
 */
function invalidateStandings(orgId: string, season: string): void {
  try {
    revalidateTag(standingsCacheTag(orgId, season), { expire: 0 });
  } catch {
    // revalidateTag throws outside a Next.js request scope (a script, a
    // background job, or — today — a repo.test.ts call with no server
    // context to attach to). The mutation that triggered this already
    // committed; worst case here is the cache serving up to 30s of stale
    // data until its own revalidate window rolls over on its own, never a
    // reason to fail the write itself.
  }
}

/** Same relationship to getStandingsWithBreakdownsForSeason's own computation as getStandingsForSeason has to getStandings — used only by lib/standings-cache.ts's getCachedStandingsWithBreakdowns. */
export async function getStandingsWithBreakdownsForSeason(
  orgId: string,
  season: string,
): Promise<Array<Standing & { breakdown: PointBreakdown }>> {
  const [attendance, members, awards, groups] = await Promise.all([
    getAttendance(orgId),
    getMembers(orgId),
    getPointAwards(orgId),
    getGroupBonusInputs(orgId),
  ]);
  return computeStandingsWithBreakdowns(attendance, members, season, awards, groups, new Date());
}

/**
 * One member's own full breakdown, regardless of eligibility — bonuses and
 * event points accrue for an ineligible member exactly as they do for an
 * eligible one (Part: "recorded, not counted, until they report"); this is
 * what /dashboard shows them so there's something real to see, even though
 * getStandings excludes them from the board entirely until they report.
 */
export async function getMemberBreakdown(orgId: string, email: string): Promise<PointBreakdown> {
  const e = normalizeEmail(email);
  const zero: PointBreakdown = {
    eventPoints: 0,
    nsbeWeekBonus: 0,
    gameBonus: 0,
    monthlyChampionBonus: 0,
    manualBonus: 0,
    adjustments: 0,
    total: 0,
  };
  const [member, attendance, awards, groups, season] = await Promise.all([
    getMember(orgId, e),
    getMemberHistory(orgId, e),
    getPointAwardsForUser(orgId, e),
    getGroupBonusInputs(orgId),
    getConfigValue(orgId, "SEASON", ""),
  ]);
  if (!member) return zero;
  return memberTotal(member, attendance, awards, groups, new Date(), season);
}

export async function getMemberSummary(orgId: string, email: string): Promise<MemberSummary> {
  const standings = await getStandings(orgId);
  return summaryFor(email, standings);
}

/**
 * The dashboard's "own row" query: `cachedStandings` (from
 * lib/standings-cache.ts's getCachedStandings, up to 30s stale) supplies
 * everyone else's rank context, but this member's own total/eligibility is
 * always computed fresh — a member must see their own points update
 * instantly after checking in, not after waiting out the cache window. Rank
 * is derived by slotting the fresh total into the cached board via
 * lib/points.ts rankWithLiveSelf, so it stays consistent with
 * computeStandings' own tie-break rules.
 */
export async function getMemberSummaryLive(
  orgId: string,
  email: string,
  season: string,
  cachedStandings: Standing[],
): Promise<MemberSummary> {
  const e = normalizeEmail(email);
  const [member, attendance, awards, groups] = await Promise.all([
    getMember(orgId, e),
    getMemberHistory(orgId, e),
    getPointAwards(orgId),
    getGroupBonusInputs(orgId),
  ]);
  if (!member || member.role !== "general" || !isEligible(member, season)) {
    return { email: e, points: 0, events: 0, rank: null, totalRanked: cachedStandings.length };
  }
  const memberAwards = awards.filter((a) => a.email === e);
  const breakdown = memberTotal(member, attendance, memberAwards, groups, new Date(), season);
  // Cached snapshot may or may not already contain this member's own (stale)
  // row — count everyone else once, then add self back in, rather than
  // trusting cachedStandings.length directly.
  const otherCount = cachedStandings.filter((s) => s.email.toLowerCase() !== e).length;
  const rank = rankWithLiveSelf(cachedStandings, {
    email: e,
    firstName: member.firstName,
    lastName: member.lastName,
    points: breakdown.total,
    events: attendance.length,
  });
  return { email: e, points: breakdown.total, events: attendance.length, rank, totalRanked: otherCount + 1 };
}

// ---------------------------------------------------------------------------
// Internal E-Board track — a second read-time interpretation of the SAME
// Registration ledger the member board reads (see lib/points.ts
// eboardAwardFor / computeEboardStandings). Never a second data store, and
// explicitly untouched by Part 1-3's tiers/NSBE-Week bonus/game bonus/
// monthly champion — computeEboardStandings doesn't even accept them.
// ---------------------------------------------------------------------------

export async function getEboardScoringConfig(orgId: string): Promise<EboardStandingsConfig> {
  const [pointValue, trackEnabledRaw, requireMembershipRaw, currentSeason] = await Promise.all([
    getConfigValue(orgId, "EBOARD_POINT_VALUE", "1"),
    getConfigValue(orgId, "EBOARD_TRACK_ENABLED", "true"),
    getConfigValue(orgId, "EBOARD_REQUIRES_MEMBERSHIP", "false"),
    getConfigValue(orgId, "SEASON", ""),
  ]);
  return {
    EBOARD_POINT_VALUE: pointValue,
    EBOARD_TRACK_ENABLED: trackEnabledRaw === "true",
    requireMembership: requireMembershipRaw === "true",
    currentSeason,
  };
}

export async function getEboardStandings(orgId: string): Promise<Standing[]> {
  const [attendance, members, config] = await Promise.all([
    getAttendance(orgId),
    getMembers(orgId),
    getEboardScoringConfig(orgId),
  ]);
  return computeEboardStandings(attendance, members, config);
}

export interface EboardCategoryStats {
  points: number;
  attended: number;
  /** Events in this category, this season, that actually happened and count toward the internal track. */
  eligible: number;
}

export interface EboardBoardRow extends Standing {
  eboardPosition: string;
  chapter: EboardCategoryStats;
  eboardMeetings: EboardCategoryStats;
  retreats: EboardCategoryStats;
}

export type EboardCategory = "chapter" | "eboardMeetings" | "retreats";

/** The breakdown is just the category code — EBOARD_MEETING/EBOARD_RETREAT are their own buckets, everything else is a chapter event. */
function eboardCategoryFor(categoryCode: string): EboardCategory {
  if (categoryCode === "EBOARD_MEETING") return "eboardMeetings";
  if (categoryCode === "EBOARD_RETREAT") return "retreats";
  return "chapter";
}

/**
 * The full internal leaderboard: standings plus, per category, points/events
 * attended and an attendance rate (attended / eligible-events-in-that-category,
 * counted across the whole season — not prorated to when a member joined, so
 * a mid-season officer's rate for earlier events is correspondingly low, by
 * design). "Eligible" events are ones that actually happened
 * (openedAt !== null) and count toward the track (category.eboardEligible).
 */
export interface EboardBoardFilter {
  from?: Date;
  to?: Date;
  category?: EboardCategory;
}

export async function getEboardBoardRows(orgId: string, filter?: EboardBoardFilter): Promise<EboardBoardRow[]> {
  const [attendanceAll, members, eventsAll, config] = await Promise.all([
    getAttendance(orgId),
    getMembers(orgId),
    getEvents(orgId),
    getEboardScoringConfig(orgId),
  ]);

  const inRange = (ts: Date | null): boolean => {
    if (!ts) return false;
    if (filter?.from && ts < filter.from) return false;
    if (filter?.to && ts > filter.to) return false;
    return true;
  };

  // Category/date-range filters (Part 4) recompute the whole board over the
  // filtered subset — points/rank reflect exactly what's currently visible,
  // not the full season with a display-only filter layered on top.
  const events = filter?.category ? eventsAll.filter((e) => eboardCategoryFor(e.category.code) === filter.category) : eventsAll;
  const eventIdsInCategory = new Set(events.map((e) => e.eventId));
  const attendance = attendanceAll.filter(
    (row) => inRange(row.timestamp) && (!filter?.category || eventIdsInCategory.has(row.eventId)),
  );

  const standings = computeEboardStandings(attendance, members, config);

  const eventById = new Map(eventsAll.map((e) => [e.eventId, e]));
  const memberByEmail = new Map(members.map((m) => [m.email, m]));

  const eligibleCounts: Record<EboardCategory, number> = { chapter: 0, eboardMeetings: 0, retreats: 0 };
  for (const e of events) {
    if (!e.category.eboardEligible || e.openedAt === null || !inRange(e.openedAt)) continue;
    eligibleCounts[eboardCategoryFor(e.category.code)] += 1;
  }

  const emptyStats = (): EboardCategoryStats => ({ points: 0, attended: 0, eligible: 0 });
  const byEmail = new Map<string, Record<EboardCategory, EboardCategoryStats>>();
  for (const s of standings) {
    byEmail.set(s.email, { chapter: emptyStats(), eboardMeetings: emptyStats(), retreats: emptyStats() });
  }
  for (const row of attendance) {
    const buckets = byEmail.get(row.email);
    if (!buckets) continue;
    const event = eventById.get(row.eventId);
    if (!event) continue;
    const stats = buckets[eboardCategoryFor(event.category.code)];
    stats.attended += 1;
    stats.points += eboardAwardFor("eboard", event.category, config);
  }
  for (const buckets of byEmail.values()) {
    for (const category of ["chapter", "eboardMeetings", "retreats"] as const) {
      buckets[category].eligible = eligibleCounts[category];
    }
  }

  return standings.map((s) => {
    const buckets = byEmail.get(s.email)!;
    return { ...s, eboardPosition: memberByEmail.get(s.email)?.eboardPosition ?? "", ...buckets };
  });
}

/**
 * Filtered directly by user (via the Registration_userId_idx), not a slice of
 * the full attendance log. A trashed event's registrations are left out — this
 * is what "Events attended" on the dashboard and the member detail page count.
 */
export async function getMemberHistory(orgId: string, email: string): Promise<AttendanceRecord[]> {
  const e = normalizeEmail(email);
  const rows = await prisma.registration.findMany({
    where: { user: { orgId, email: e, ...LIVE }, event: { orgId, ...LIVE } },
    include: REGISTRATION_ATTENDANCE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(registrationToAttendance);
}

export async function getAuthRecords(orgId: string): Promise<AuthRecord[]> {
  const users = await prisma.user.findMany({ where: { orgId, ...LIVE } });
  return users.map(userToAuthRecord);
}

export async function getAdminLog(orgId: string): Promise<AdminLogEntry[]> {
  const rows = await prisma.adminLog.findMany({
    where: { orgId },
    include: { actor: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(adminLogToDomain);
}

export interface EventWithStats extends Event {
  registrationCount: number;
}

/**
 * One query with a _count aggregate — not one COUNT per event. Trashed events
 * are left out. registrationCount is the event's HEADCOUNT and deliberately
 * still counts a trashed member's registration: trashing a person hides the
 * person, it does not un-happen their attendance (see trashMember).
 */
export async function getEventsWithStats(orgId: string): Promise<EventWithStats[]> {
  const rows = await prisma.event.findMany({
    where: { orgId, ...LIVE },
    include: { ...EVENT_INCLUDE, _count: { select: { registrations: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((e) => ({ ...eventToDomain(e), registrationCount: e._count.registrations }));
}

export interface EventResponseRow {
  id: string;
  timestamp: Date | null;
  email: string;
  firstName: string;
  lastName: string;
  pointsAwarded: number;
  answers: Record<string, string>;
}

/** One query (Registration -> User + Answers) per event — never one query per response. Feeds the responses page and every responses export, so a trashed member's row is left out of all of them. */
export async function getEventResponses(orgId: string, eventId: string): Promise<EventResponseRow[]> {
  const rows = await prisma.registration.findMany({
    where: { eventId, ...liveRegistrationWhere(orgId) },
    include: {
      user: { select: { email: true, firstName: true, lastName: true } },
      answers: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.createdAt,
    email: r.user.email,
    firstName: r.user.firstName,
    lastName: r.user.lastName,
    pointsAwarded: r.pointsAwarded,
    answers: Object.fromEntries(r.answers.map((a) => [a.fieldKey, a.value])),
  }));
}

/**
 * Whether an event's schema is locked — true once even one response has been
 * submitted. Server-side gate for the form builder; a disabled control on the
 * client is UX only, never the actual security boundary.
 *
 * Deliberately NOT trash-filtered on the registrant: a trashed member's
 * answers still exist (and come back on restore), so the schema they were
 * written against stays locked.
 */
export async function hasEventResponses(orgId: string, eventId: string): Promise<boolean> {
  const row = await prisma.registration.findFirst({ where: { eventId, event: { orgId } }, select: { id: true } });
  return row !== null;
}

/**
 * Active: mustChangePassword is false — a real password has been chosen,
 * whether via self-service signup (immediate) or /set-password after a setup
 * code. Otherwise pending — distinguished by the most recent AdminLog entry
 * that touched this account, since mustChangePassword alone can't tell "never
 * set up" from "was reset" apart.
 */
export async function getAccountState(
  email: string,
  auth: AuthRecord | null,
  log: AdminLogEntry[],
): Promise<AccountState> {
  if (auth && !auth.mustChangePassword) return "active";
  const e = normalizeEmail(email);
  const last = log.find(
    (l) => l.target.toLowerCase() === e && (l.action === "create_member" || l.action === "reset_password"),
  );
  return last?.action === "reset_password" ? "reset_pending" : "setup_pending";
}

export interface MemberWithStats extends Member {
  /**
   * The TRUE season total (lib/points.ts memberTotal — event points, every
   * bonus, and adjustments), regardless of eligibility and possibly negative:
   * admins need the real number, unlike the member-facing surfaces, which
   * clamp at 0 (displayTotal).
   */
  points: number;
  /** Registrations for LIVE events only — a trashed event drops out of this count until restored. */
  events: number;
  accountState: AccountState;
  eligible: boolean;
  /** Precomputed so the roster can't re-derive them off the raw flags and get it wrong — see lib/claim-state.ts. */
  duesState: ClaimState;
  nationalState: ClaimState;
  /** Display name of whoever verified the claim, resolved from *VerifiedById. Empty when not verified, or when the id points at a row that no longer exists. */
  duesVerifiedByName: string;
  nationalVerifiedByName: string;
  houseState: "none" | "pending" | "verified";
  /** Most recent of: last attendance, last AdminLog entry touching this member. Null if neither exists. */
  lastActiveAt: Date | null;
}

/**
 * Turns the *VerifiedById columns on one member into display names. The
 * columns are plain nullable Strings with no foreign key (see the schema), so
 * an id can point at a deleted row, or at the literal HOUSE_SYSTEM_VERIFIER
 * sentinel — both resolve to "" and the caller renders the date alone rather
 * than inventing a verifier. getMembersWithStats does the same resolution
 * off the roster it already has in hand.
 */
export async function resolveVerifierNames(
  orgId: string,
  member: Pick<Member, "duesVerifiedById" | "nationalVerifiedById" | "houseVerifiedById">,
): Promise<{ duesVerifiedByName: string; nationalVerifiedByName: string; houseVerifiedByName: string }> {
  const ids = [member.duesVerifiedById, member.nationalVerifiedById, member.houseVerifiedById].filter(
    (id): id is string => Boolean(id) && id !== HOUSE_SYSTEM_VERIFIER,
  );
  const rows =
    ids.length === 0
      ? []
      : await prisma.user.findMany({
          where: { orgId, id: { in: ids }, ...LIVE },
          select: { id: true, firstName: true, lastName: true, email: true },
        });
  const byId = new Map(rows.map((r) => [r.id, memberDisplayName(r.firstName, r.lastName, r.email)]));
  return {
    duesVerifiedByName: byId.get(member.duesVerifiedById) ?? "",
    nationalVerifiedByName: byId.get(member.nationalVerifiedById) ?? "",
    houseVerifiedByName:
      member.houseVerifiedById === HOUSE_SYSTEM_VERIFIER
        ? "verified on selection"
        : byId.get(member.houseVerifiedById) ?? "",
  };
}

/**
 * The TRUE season breakdown (memberTotal) for a set of members, in three
 * queries whatever the set's size — the Member Directory's page and its CSV
 * export. Same inputs as the standings computation, trash filters included,
 * so a directory total can never disagree with the member's own breakdown.
 */
async function trueTotalsFor(orgId: string, members: Member[], season: string): Promise<Map<string, PointBreakdown>> {
  const totals = new Map<string, PointBreakdown>();
  if (members.length === 0) return totals;
  const ids = members.map((m) => m.id);
  const [registrations, awards, groups] = await Promise.all([
    prisma.registration.findMany({
      where: { userId: { in: ids }, ...liveRegistrationWhere(orgId) },
      include: REGISTRATION_ATTENDANCE_INCLUDE,
    }),
    prisma.pointAward.findMany({
      where: { userId: { in: ids }, ...liveAwardWhere(orgId) },
      include: { user: { select: { email: true } } },
    }),
    getGroupBonusInputs(orgId),
  ]);
  const attendance = registrations.map(registrationToAttendance);
  const allAwards = awards.map(pointAwardToDomain);
  const now = new Date();
  for (const m of members) {
    totals.set(
      m.email,
      memberTotal(
        m,
        attendance.filter((a) => a.email === m.email),
        allAwards.filter((a) => a.email === m.email),
        groups,
        now,
        season,
      ),
    );
  }
  return totals;
}

export async function getMembersWithStats(orgId: string): Promise<MemberWithStats[]> {
  const [members, attendance, authRecords, log, currentSeason] = await Promise.all([
    getMembers(orgId),
    getAttendance(orgId),
    getAuthRecords(orgId),
    getAdminLog(orgId),
    getConfigValue(orgId, "SEASON", ""),
  ]);
  const trueTotals = await trueTotalsFor(orgId, members, currentSeason);
  const totalsByEmail = new Map<string, { events: number }>();
  const lastAttendanceByEmail = new Map<string, Date>();
  for (const row of attendance) {
    const entry = totalsByEmail.get(row.email) ?? { events: 0 };
    entry.events += 1;
    totalsByEmail.set(row.email, entry);
    if (row.timestamp) {
      const existing = lastAttendanceByEmail.get(row.email);
      if (!existing || row.timestamp > existing) lastAttendanceByEmail.set(row.email, row.timestamp);
    }
  }
  // log is already sorted createdAt desc (see getAdminLog) — the first entry
  // seen for a given target is its most recent.
  const lastLogByEmail = new Map<string, Date>();
  for (const entry of log) {
    const key = normalizeEmail(entry.target);
    if (!lastLogByEmail.has(key) && entry.timestamp) lastLogByEmail.set(key, entry.timestamp);
  }
  const authByEmail = new Map(authRecords.map((a) => [a.email, a]));
  // *VerifiedById holds a User id; the roster already has every member in
  // hand, so resolving it to a name is a local lookup rather than another
  // query. HOUSE_SYSTEM_VERIFIER and a since-deleted admin both fall through
  // to "" — the caller renders the date alone rather than inventing a name.
  const nameById = new Map(members.map((m) => [m.id, memberDisplayName(m.firstName, m.lastName, m.email)]));

  return Promise.all(
    members.map(async (m) => {
      const totals = totalsByEmail.get(m.email);
      const accountState = await getAccountState(m.email, authByEmail.get(m.email) ?? null, log);
      const houseState: MemberWithStats["houseState"] = m.houseVerifiedAt
        ? "verified"
        : m.house
          ? "pending"
          : "none";
      const lastAttended = lastAttendanceByEmail.get(m.email) ?? null;
      const lastLogged = lastLogByEmail.get(normalizeEmail(m.email)) ?? null;
      const lastActiveAt =
        lastAttended && lastLogged ? (lastAttended > lastLogged ? lastAttended : lastLogged) : lastAttended ?? lastLogged;
      return {
        ...m,
        points: trueTotals.get(m.email)?.total ?? 0,
        events: totals?.events ?? 0,
        accountState,
        eligible: isEligible(m, currentSeason),
        duesState: claimState(m.duesPaidReported, m.duesVerifiedAt, m.duesRevokedAt),
        nationalState: claimState(m.nationalMemberReported, m.nationalVerifiedAt, m.nationalRevokedAt),
        duesVerifiedByName: nameById.get(m.duesVerifiedById) ?? "",
        nationalVerifiedByName: nameById.get(m.nationalVerifiedById) ?? "",
        houseState,
        lastActiveAt,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Membership verification queue — the operational cost of ELIGIBILITY_MODE
// VERIFIED. Every action here writes to AdminLog like every other admin
// mutation (see logAdminAction).
// ---------------------------------------------------------------------------

/**
 * The three queue queries below deliberately filter on NOTHING but the claim
 * state itself (see lib/claim-state.ts — this WHERE is the SQL spelling of
 * `claimState(...) === "pending"`).
 *
 * In particular there is no role filter. These used to carry
 * `role: GENERAL`, which silently hid every E-Board claim from the audit
 * queue — 31 of 34 outstanding dues claims on the Howard roster, because an
 * officer pays chapter dues and holds a national membership like anyone
 * else. A claim is audited on its state, never on who made it.
 *
 * `*RevokedAt: null` is the other half of "pending": a revoked claim has
 * already been adjudicated and does not belong in a queue of undecided ones.
 * Re-reporting clears the revoke stamps (see setDuesReported), so a member
 * who claims again after a revoke comes back here as a new pending claim
 * rather than disappearing behind a stale decision.
 */
/**
 * How many rows any one verification queue will render at once.
 *
 * The queues are capped rather than cursor-paginated like the roster, because
 * they are a different shape of list: each one holds only OUTSTANDING claims
 * and DRAINS as it is worked, where the roster only ever grows. A cap keeps a
 * signup-rush spike from rendering hundreds of rows; the count beside it says
 * how much is left, and the queue refills from the top as items are cleared.
 */
export const VERIFICATION_QUEUE_LIMIT = 100;

export interface VerificationQueueResult {
  members: Member[];
  /** Everything outstanding, not just the capped page — so the page can say "100 of 214 waiting". */
  total: number;
}

export async function getDuesPendingMembers(orgId: string): Promise<VerificationQueueResult> {
  const where = { orgId, duesPaidReported: true, duesVerifiedAt: null, duesRevokedAt: null, ...LIVE };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { duesReportedAt: "asc" }, take: VERIFICATION_QUEUE_LIMIT }),
    prisma.user.count({ where }),
  ]);
  return { members: rows.map(userToMember), total };
}

export async function getNationalPendingMembers(orgId: string): Promise<VerificationQueueResult> {
  const where = { orgId, nationalMemberReported: true, nationalVerifiedAt: null, nationalRevokedAt: null, ...LIVE };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: "asc" }, take: VERIFICATION_QUEUE_LIMIT }),
    prisma.user.count({ where }),
  ]);
  return { members: rows.map(userToMember), total };
}

export async function getHousePendingMembers(orgId: string): Promise<VerificationQueueResult> {
  const where = { orgId, house: { not: null }, houseVerifiedAt: null, ...LIVE };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: "asc" }, take: VERIFICATION_QUEUE_LIMIT }),
    prisma.user.count({ where }),
  ]);
  return { members: rows.map(userToMember), total };
}

/** Accounts with no House on file at all — the state getMissingFields re-asks for, surfaced so an admin can find them instead of discovering one by accident. ADMIN accounts are excluded: they never get a House step (see joinWizardRules.ts stepsFor) and getMissingFields never asks them for one, so listing them here would be noise, not a gap. */
export async function getHouseMissingMembers(orgId: string): Promise<VerificationQueueResult> {
  const where = { orgId, house: null, role: { not: DbRole.ADMIN }, ...LIVE };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: "asc" }, take: VERIFICATION_QUEUE_LIMIT }),
    prisma.user.count({ where }),
  ]);
  return { members: rows.map(userToMember), total };
}

/**
 * Resolves the acting admin's User id for a *VerifiedById/*RevokedById
 * column. Every verify below records one: a verified claim with no verifier
 * on it is unauditable — "verified by whom?" has no answer — and the repair
 * script (scripts/repair-claim-state.ts) can only report such a row, never
 * reconstruct it.
 */
async function actorUserId(tx: Tx, orgId: string, actor: string): Promise<string | null> {
  const row = await tx.user.findUnique({
    where: { orgId_email: { orgId, email: normalizeEmail(actor) } },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Verify/Revoke are pure audit now — neither gates the leaderboard (see lib/points.ts isEligible). Mutually exclusive: verifying clears a past revoke, and vice versa — that invariant is what lets lib/claim-state.ts claimState resolve a row to exactly one of four states. */
export async function verifyDues(orgId: string, email: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        duesVerifiedAt: new Date(),
        duesVerifiedById: await actorUserId(tx, orgId, actor),
        duesRevokedAt: null,
        duesRevokedById: null,
        duesRevokedNote: null,
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "verify_dues", target: e });
  });
}

/** Requires a note — an admin actively determined the self-reported claim was false. Drops the member from the leaderboard immediately and re-arms the check-in question (sets duesPaidReported false, same field the leaderboard filter and core-form re-ask both read). */
export async function revokeDues(orgId: string, email: string, actor: string, note: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        duesPaidReported: false,
        duesVerifiedAt: null,
        duesVerifiedById: null,
        duesRevokedAt: new Date(),
        duesRevokedById: await actorUserId(tx, orgId, actor),
        duesRevokedNote: note,
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "revoke_dues", target: e, detail: note });
  });
  // duesPaidReported flips to false — can drop this member off the leaderboard.
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

export async function verifyNational(orgId: string, email: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        nationalVerifiedAt: new Date(),
        nationalVerifiedById: await actorUserId(tx, orgId, actor),
        nationalRevokedAt: null,
        nationalRevokedById: null,
        nationalRevokedNote: null,
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "verify_national", target: e });
  });
}

export async function revokeNational(orgId: string, email: string, actor: string, note: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        nationalMemberReported: false,
        nationalVerifiedAt: null,
        nationalVerifiedById: null,
        nationalRevokedAt: new Date(),
        nationalRevokedById: await actorUserId(tx, orgId, actor),
        nationalRevokedNote: note,
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "revoke_national", target: e, detail: note });
  });
  // nationalMemberReported flips to false — can drop this member off the leaderboard.
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

export async function verifyHouse(orgId: string, email: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: { houseVerifiedAt: new Date(), houseVerifiedById: await actorUserId(tx, orgId, actor) },
    });
    await logAdminAction(tx, orgId, { actor, action: "verify_house", target: e });
  });
}

export async function rejectHouse(orgId: string, email: string, actor: string, note?: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: { house: null, houseVerifiedAt: null, houseVerifiedById: null, houseProofFileId: null },
    });
    await logAdminAction(tx, orgId, { actor, action: "reject_house", target: e, detail: note });
  });
}

/** Admin correction — the only path to change a House once it's verified. Requires a note (same shape as revokeDues/revokeNational) so the AdminLog entry explains why a verified House was overridden. */
export async function correctHouse(orgId: string, email: string, house: string, note: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: { house, houseVerifiedAt: new Date(), houseVerifiedById: await actorUserId(tx, orgId, actor) },
    });
    await logAdminAction(tx, orgId, { actor, action: "correct_house", target: e, detail: `${house} — ${note}` });
  });
}

// ---------------------------------------------------------------------------
// Self-service mutators — shared by /account, signup completion, and (for
// updateProfileFields) admin edits. registerForEvent applies the identical
// dues/national write rule inline, in the SAME transaction as the
// Registration it's creating (see Part 2) — it does not call these, but the
// rule (transitioning to true stamps membershipSeason; "No" doesn't touch
// it) is the one place that rule is documented; keep both in sync.
// ---------------------------------------------------------------------------

/** "Mark as paid" from /account, or an admin toggling it directly — the same season-stamp rule registerForEvent's check-in answer applies. */
export async function setDuesReported(orgId: string, email: string, reported: boolean, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  const currentSeason = await getConfigValue(orgId, "SEASON", "");
  const season = reported ? currentSeason : null;
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        duesPaidReported: reported,
        duesReportedAt: new Date(),
        ...(season !== null ? { membershipSeason: season } : {}),
        // A fresh "yes" is a NEW claim, so it clears a previous revoke —
        // the old decision was about the old claim. Without this the row
        // keeps duesRevokedAt set while duesPaidReported is true again:
        // claimState resolves it to "revoked", the audit queue (pending
        // only) never shows it, and the member sits on the leaderboard
        // with a claim no admin can ever reach. Revoking again is one
        // click; a permanently invisible claim is not recoverable.
        ...(reported ? { duesRevokedAt: null, duesRevokedById: null, duesRevokedNote: null } : {}),
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "report_dues", target: e, detail: String(reported) });
  });
  // Toggling duesPaidReported can move this member on or off the leaderboard
  // (see lib/points.ts isEligible).
  invalidateStandings(orgId, currentSeason);
}

export async function setNationalReported(
  orgId: string,
  email: string,
  reported: boolean,
  actor: string,
  nsbeMembershipId?: string,
): Promise<void> {
  const e = normalizeEmail(email);
  const currentSeason = await getConfigValue(orgId, "SEASON", "");
  const season = reported ? currentSeason : null;
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        nationalMemberReported: reported,
        ...(season !== null ? { membershipSeason: season } : {}),
        // Same "a new claim supersedes the old decision" rule as setDuesReported.
        ...(reported ? { nationalRevokedAt: null, nationalRevokedById: null, nationalRevokedNote: null } : {}),
        // Written whenever one was supplied, whatever `reported` says, and
        // never cleared as a side effect of answering No — the ID is an
        // independent field (a prior year's, or one still pending).
        ...(nsbeMembershipId !== undefined ? { nsbeMembershipId: nsbeMembershipId.trim() || null } : {}),
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "report_national", target: e, detail: String(reported) });
  });
  invalidateStandings(orgId, currentSeason);
}

/**
 * houseVerifiedById when an E-Board member's House is verified on selection.
 * Every other *VerifiedById/*RevokedById column holds a User id resolved
 * from the acting admin's email (see revokeDues); there is no acting admin
 * here, so this records the system as the verifier. The column is a plain
 * nullable String with no foreign key, and nothing reads it back today.
 */
export const HOUSE_SYSTEM_VERIFIER = "system";

/**
 * Same "write house+proof together, leave houseVerifiedAt null (pending
 * review)" shape registerForEvent already applies inline for an unverified
 * member — used by signup completion and /account.
 *
 * Once houseVerifiedAt is set, this is a member-facing endpoint and MUST
 * reject the write server-side — a hidden "Edit" button (HouseSection.tsx
 * only renders one while unverified) is a UI nicety, not an access control.
 * The only path to change a verified House is an admin correction, see
 * correctHouse above.
 */
export async function setHouseAssignment(
  orgId: string,
  email: string,
  house: string,
  houseProofFileId: string | undefined,
  actor: string,
): Promise<void> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  if (user.houseVerifiedAt !== null) {
    throw new AppError("FORBIDDEN", "Your House is verified — contact an E-Board member to request a change.");
  }
  // The roster role, never a client-supplied or session-cached one — this is
  // the enforcement point for houseSelfVerifies, so it reads the same row it
  // is about to write.
  const selfVerifies = houseSelfVerifies(roleFromDb(user.role));
  if (!selfVerifies && !houseProofFileId) {
    throw new AppError("VALIDATION_FAILED", "Upload your House test result.", {
      fieldErrors: { houseProofFileId: "Upload your House test result." },
    });
  }
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: selfVerifies
        ? // Verified at the moment of selection, with no proof row to point
          // at. From here it is locked on exactly the same terms as any
          // admin-verified House — the guard above rejects every later
          // self-service write, leaving correctHouse as the only way to
          // change it.
          { house, houseProofFileId: null, houseVerifiedAt: new Date(), houseVerifiedById: HOUSE_SYSTEM_VERIFIER }
        : { house, houseProofFileId },
    });
    await logAdminAction(tx, orgId, {
      actor,
      action: "set_house",
      target: e,
      detail: selfVerifies ? `${house} — verified on selection (E-Board)` : house,
    });
  });
}

/**
 * Explicit "I haven't taken the test yet" from /account — clears any
 * unverified House (and its proof) so a member can back out of a partial or
 * previously-submitted assignment. Same verified-lock as setHouseAssignment
 * above. A no-op (no write, no AdminLog entry) when there's nothing to
 * clear — a fresh member choosing "skip" for the first time never had a
 * House to begin with.
 */
export async function clearHouseAssignment(orgId: string, email: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  if (user.houseVerifiedAt !== null) {
    throw new AppError("FORBIDDEN", "Your House is verified — contact an E-Board member to request a change.");
  }
  if (user.house === null && user.houseProofFileId === null) return;
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, { where: { orgId_email: { orgId, email: e }, ...LIVE }, data: { house: null, houseProofFileId: null } });
    await logAdminAction(tx, orgId, { actor, action: "clear_house", target: e });
  });
}

// ---------------------------------------------------------------------------
// The signup latch (User.signupCompletedAt — see lib/signup.ts).
// ---------------------------------------------------------------------------

/**
 * Everything lib/signup.ts needs to decide whether a signup is finished and,
 * if not, where it resumes. One row read; nothing derived here, because the
 * rules live in lib/signup.ts and must have exactly one implementation.
 *
 * Returns the whole Member — which satisfies SignupUser structurally — so the
 * resume page can seed its form from the same read, rather than fetching the
 * row twice for two views of it.
 */
export async function getSignupUser(orgId: string, email: string): Promise<Member | null> {
  const row = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: normalizeEmail(email) }, ...LIVE } });
  if (!row) return null;
  // Member already carries every field SignupUser needs, the latch included.
  return userToMember(row);
}

/**
 * Latches the signup as finished — the ONE place that writes
 * signupCompletedAt outside the backfill migration and the seed.
 *
 * Refuses unless lib/signup.ts requiredSignupFieldsComplete agrees, re-derived
 * here from the row rather than trusted from the client: the resume flow's
 * "am I done" and the server's "may I latch" must be the same question, or a
 * crafted request could buy its way into the app with an empty profile.
 *
 * `houseSkipped` is the single exception, and it is the same trust
 * join/actions.ts setHouseAction has always taken: pressing "I haven't taken
 * the test yet" is a client-side declaration by nature — it writes nothing, so
 * there is nothing for the server to read back (see clearHouseAssignment and
 * docs/CLAIM-STATE.md).
 *
 * Idempotent: an already-latched account returns its existing timestamp rather
 * than moving it, so a double-submitted finish is harmless.
 */
export async function completeSignup(
  orgId: string,
  email: string,
  options: { houseSkipped?: boolean } = {},
): Promise<{ completedAt: Date; missingSteps: StepKey[] }> {
  const e = normalizeEmail(email);
  const user = await getSignupUser(orgId, e);
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  if (user.signupCompletedAt) return { completedAt: user.signupCompletedAt, missingSteps: [] };

  const missingSteps = missingSignupSteps(user, options);
  if (missingSteps.length > 0) {
    throw new AppError("VALIDATION_FAILED", "There are still steps left to finish.");
  }

  const completedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, { where: { orgId_email: { orgId, email: e }, ...LIVE }, data: { signupCompletedAt: completedAt } });
    await logAdminAction(tx, orgId, { actor: e, action: "complete_signup", target: e });
  });
  return { completedAt, missingSteps: [] };
}

export async function setResume(orgId: string, email: string, resumeFileId: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: { resumeFileId, resumeUpdatedAt: now, resumeConsentAt: now },
    });
    await logAdminAction(tx, orgId, { actor, action: "set_resume", target: e });
  });
}

/** Withdraws consent — detaches the resume (clears the pointer + consent timestamp). Doesn't delete the underlying UploadedFile row/bytes: a hard-delete-from-storage feature is out of scope here. */
export async function removeResume(orgId: string, email: string, actor: string): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.$transaction(async (tx) => {
    await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: { resumeFileId: null, resumeUpdatedAt: null, resumeConsentAt: null },
    });
    await logAdminAction(tx, orgId, { actor, action: "remove_resume", target: e });
  });
}

export interface ProfileFieldsInput {
  firstName?: string;
  lastName?: string;
  studentId?: string;
  classification?: Classification;
  major?: string;
  majorOther?: string;
  phone?: string;
  personalEmail?: string;
  tshirtSize?: ShirtSize;
  nsbeMembershipId?: string;
}

/** Shared by self-service (/account) and admin (/admin/members/[id]) profile edits — same AdminLog action either way, so edits are traceable regardless of actor. */
export async function updateProfileFields(
  orgId: string,
  email: string,
  fields: ProfileFieldsInput,
  actor: string,
): Promise<Member> {
  const e = normalizeEmail(email);
  // Writing classification or major here is the same "confirmed for this
  // season" event as answering the check-in gap-filler question — stamp
  // profileSeason so getMissingFields doesn't immediately re-ask (Part: the
  // seasonal refresh applies no matter which surface wrote the value).
  const stampProfileSeason = fields.classification !== undefined || fields.major !== undefined;
  const season = stampProfileSeason ? await getConfigValue(orgId, "SEASON", "") : null;
  return prisma.$transaction(async (tx) => {
    const row = await updateLiveUser(tx, {
      where: { orgId_email: { orgId, email: e }, ...LIVE },
      data: {
        ...(fields.firstName !== undefined ? { firstName: fields.firstName } : {}),
        ...(fields.lastName !== undefined ? { lastName: fields.lastName } : {}),
        ...(fields.studentId !== undefined ? { studentId: fields.studentId } : {}),
        ...(fields.classification !== undefined ? { classification: classificationToDb(fields.classification) } : {}),
        ...(fields.major !== undefined ? { major: fields.major } : {}),
        ...(fields.majorOther !== undefined ? { majorOther: fields.majorOther } : {}),
        ...(season !== null ? { profileSeason: season } : {}),
        ...(fields.phone !== undefined ? { phone: fields.phone || null } : {}),
        ...(fields.personalEmail !== undefined ? { personalEmail: fields.personalEmail || null } : {}),
        ...(fields.tshirtSize !== undefined ? { tshirtSize: shirtSizeToDb(fields.tshirtSize) } : {}),
        ...(fields.nsbeMembershipId !== undefined ? { nsbeMembershipId: fields.nsbeMembershipId || null } : {}),
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "update_profile", target: e });
    return userToMember(row);
  });
}

/** Self-service password change — verifies the current password first (unlike setPassword, used by the forced-setup-code flow, which trusts the caller already). */
export async function changePassword(orgId: string, email: string, currentPassword: string, newPassword: string): Promise<void> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    throw new AppError("VALIDATION_FAILED", "Current password is incorrect", {
      fieldErrors: { currentPassword: "Current password is incorrect" },
    });
  }
  await setPassword(orgId, e, newPassword);
}

// ---------------------------------------------------------------------------
// Uploaded files — never publicly addressable, see lib/storage.ts and
// GET /api/files/[id]. This module never returns storageKey to a caller
// outside this file.
// ---------------------------------------------------------------------------

export interface CreateUploadedFileInput {
  orgId: string;
  userId: string;
  kind: FileKind;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function createUploadedFile(input: CreateUploadedFileInput): Promise<UploadedFile> {
  const row = await prisma.uploadedFile.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      kind: fileKindToDb(input.kind),
      storageKey: input.storageKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    },
  });
  return uploadedFileToDomain(row);
}

/**
 * Owner or EBOARD-or-above only — GET /api/files/[id]'s entire authorization
 * rule, pulled out as a pure predicate so it's directly unit-testable without
 * the Next.js request-scoped auth context repo.ts's other consumers need.
 */
export function canAccessFile(file: { ownerEmail: string }, requester: { email: string; role: Role }): boolean {
  return (
    normalizeEmail(file.ownerEmail) === normalizeEmail(requester.email) ||
    requester.role === "eboard" ||
    requester.role === "admin"
  );
}

/**
 * Records that someone looked at a file they do not own — the FILES domain's
 * audit requirement, written by GET /api/files/[id] on every such request.
 *
 * Owner views are deliberately NOT logged: a member opening their own resume is
 * not an access event anyone needs to answer for, and logging it would bury the
 * entries that matter under noise.
 *
 * This got more load-bearing the moment House screenshots became properly
 * viewable (see components/ui/ImageLightbox.tsx). Easier viewing means more
 * viewing, and the trail is what keeps that accountable — so one row per
 * non-owner request, including the two a thumbnail-then-lightbox open produces.
 * Under-reporting would be worse than repetition.
 */
export async function logFileView(
  orgId: string,
  entry: { actor: string; fileId: string; kind: FileKind; ownerEmail: string; originalName: string },
): Promise<void> {
  await logSystemAdminEvent(orgId, {
    actor: entry.actor,
    action: "view_file",
    target: entry.fileId,
    detail: `${entry.kind} of ${entry.ownerEmail} (${entry.originalName})`,
  });
}

/** Internal to the file-serving route only — carries storageKey, never exposed elsewhere. */
export async function getUploadedFileForServing(
  orgId: string,
  id: string,
): Promise<(UploadedFile & { storageKey: string; ownerEmail: string }) | null> {
  // A trashed member's files are kept until permanent deletion, but served to
  // nobody meanwhile — the owner can't sign in, and to anyone else they're
  // hidden like the rest of the account.
  const row = await prisma.uploadedFile.findFirst({
    where: { id, orgId, user: LIVE },
    include: { user: { select: { email: true } } },
  });
  if (!row) return null;
  return { ...uploadedFileToDomain(row), storageKey: row.storageKey, ownerEmail: row.user.email };
}

// ---------------------------------------------------------------------------
// Event categories (Part 1) — replaces the old flat PointSystem. Full CRUD
// from /admin/settings/categories; every point value is data, never
// hardcoded — see lib/points.ts memberPointsFor/eboardAwardFor, which only
// ever read category.memberPoints/eboardEligible fresh at call time.
// ---------------------------------------------------------------------------

export async function getEventCategories(orgId: string): Promise<EventCategory[]> {
  const rows = await prisma.eventCategory.findMany({ where: { orgId }, orderBy: { sortOrder: "asc" } });
  return rows.map(eventCategoryToDomain);
}

export interface EventCategoryInput {
  code: string;
  name: string;
  shortName: string;
  tier: number | null;
  memberPoints: number;
  examples?: string;
  countsForMonthly?: boolean;
  eboardEligible?: boolean;
  audience?: Audience;
  active?: boolean;
  sortOrder?: number;
}

export async function createEventCategory(orgId: string, input: EventCategoryInput, actor: string): Promise<EventCategory> {
  return prisma.$transaction(async (tx) => {
    let row: EventCategoryModel;
    try {
      row = await tx.eventCategory.create({
        data: {
          orgId,
          code: input.code,
          name: input.name,
          shortName: input.shortName,
          tier: input.tier,
          memberPoints: input.memberPoints,
          examples: input.examples || null,
          countsForMonthly: input.countsForMonthly ?? true,
          eboardEligible: input.eboardEligible ?? true,
          audience: audienceToDb(input.audience ?? "all"),
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError("VALIDATION_FAILED", "A category with this code already exists.", {
          fieldErrors: { code: "A category with this code already exists." },
        });
      }
      throw err;
    }
    await logAdminAction(tx, orgId, { actor, action: "create_category", target: row.id, detail: input.code });
    return eventCategoryToDomain(row);
  });
}

/**
 * Point-value edits are never blocked (they're data, not schema) — the admin
 * UI is responsible for warning that this changes every past registration's
 * DERIVED total with no backfill (see lib/points.ts memberPointsFor) and
 * offering a standings snapshot first.
 */
export async function updateEventCategory(
  orgId: string,
  id: string,
  input: Partial<EventCategoryInput>,
  actor: string,
): Promise<EventCategory> {
  const category = await prisma.$transaction(async (tx) => {
    const existing = await tx.eventCategory.findFirst({ where: { id, orgId } });
    if (!existing) throw new AppError("NOT_FOUND", "Category not found");
    const row = await tx.eventCategory.update({
      where: { id },
      data: {
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shortName !== undefined ? { shortName: input.shortName } : {}),
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
        ...(input.memberPoints !== undefined ? { memberPoints: input.memberPoints } : {}),
        ...(input.examples !== undefined ? { examples: input.examples || null } : {}),
        ...(input.countsForMonthly !== undefined ? { countsForMonthly: input.countsForMonthly } : {}),
        ...(input.eboardEligible !== undefined ? { eboardEligible: input.eboardEligible } : {}),
        ...(input.audience !== undefined ? { audience: audienceToDb(input.audience) } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
    await logAdminAction(tx, orgId, {
      actor,
      action: "update_category",
      target: id,
      detail: input.memberPoints !== undefined ? `memberPoints -> ${input.memberPoints}` : input.code,
    });
    return eventCategoryToDomain(row);
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return category;
}

// ---------------------------------------------------------------------------
// NSBE Week / event groups (Part 2). The completion bonus is derived at read
// time (see lib/points.ts groupBonusFor/isGroupComplete) — nothing here ever
// stores a computed bonus value.
// ---------------------------------------------------------------------------

/** A group's eventIds, as every EventGroup read returns them: live events only. */
const GROUP_EVENT_IDS = { events: { where: LIVE, select: { id: true } } } as const;

export async function getEventGroups(orgId: string): Promise<EventGroup[]> {
  const rows = await prisma.eventGroup.findMany({
    where: { orgId },
    include: GROUP_EVENT_IDS,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(eventGroupToDomain);
}

export async function getEventGroup(orgId: string, id: string): Promise<EventGroup | null> {
  const row = await prisma.eventGroup.findFirst({ where: { id, orgId }, include: GROUP_EVENT_IDS });
  return row ? eventGroupToDomain(row) : null;
}

export interface CreateEventGroupInput {
  orgId: string;
  name: string;
  slug?: string;
  kind?: GroupKind;
  expectedEventCount?: number;
  bonusTiers: BonusTier[];
  createdBy: string;
}

export async function createEventGroup(input: CreateEventGroupInput): Promise<EventGroup> {
  const { orgId } = input;
  return prisma.$transaction(async (tx) => {
    const base = slugify(input.slug || input.name);
    let slug = base;
    let n = 2;
    for (;;) {
      const existing = await tx.eventGroup.findUnique({ where: { orgId_slug: { orgId, slug } } });
      if (!existing) break;
      slug = `${base}-${n++}`;
    }
    const row = await tx.eventGroup.create({
      data: {
        orgId,
        name: input.name,
        slug,
        kind: groupKindToDb(input.kind ?? "nsbe_week"),
        expectedEventCount: input.expectedEventCount ?? 5,
        bonusTiers: input.bonusTiers as unknown as Prisma.InputJsonValue,
      },
      include: GROUP_EVENT_IDS,
    });
    await logAdminAction(tx, orgId, { actor: input.createdBy, action: "create_group", target: row.id, detail: input.name });
    return eventGroupToDomain(row);
  });
}

export async function updateEventGroupTiers(
  orgId: string,
  id: string,
  bonusTiers: BonusTier[],
  actor: string,
): Promise<EventGroup> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.eventGroup.findFirst({ where: { id, orgId } });
    if (!existing) throw new AppError("NOT_FOUND", "Group not found");
    const row = await tx.eventGroup.update({
      where: { id },
      data: { bonusTiers: bonusTiers as unknown as Prisma.InputJsonValue },
      include: GROUP_EVENT_IDS,
    });
    await logAdminAction(tx, orgId, { actor, action: "update_group_tiers", target: id });
    return eventGroupToDomain(row);
  });
}

/** Assigns (or, with groupId null, removes) an event to/from a group — the /admin/groups matrix UI's write path onto Event.groupId. */
export async function setEventGroup(orgId: string, eventId: string, groupId: string | null, actor: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const event = await tx.event.findFirst({ where: { id: eventId, orgId, ...LIVE } });
    if (!event) throw new AppError("NOT_FOUND", "Event not found");
    if (groupId) {
      const group = await tx.eventGroup.findFirst({ where: { id: groupId, orgId } });
      if (!group) throw new AppError("NOT_FOUND", "Group not found");
    }
    await tx.event.update({ where: { id: eventId }, data: { groupId } });
    await logAdminAction(tx, orgId, { actor, action: "set_event_group", target: eventId, detail: groupId ?? "none" });
  });
}

/** The manual override (Part 2) — settles the bonus against whatever events actually exist, for when a planned event in the set is canceled and never happens. */
export async function finalizeEventGroup(orgId: string, id: string, actor: string): Promise<EventGroup> {
  const group = await prisma.$transaction(async (tx) => {
    const existing = await tx.eventGroup.findFirst({ where: { id, orgId } });
    if (!existing) throw new AppError("NOT_FOUND", "Group not found");
    const actorUser = await tx.user.findUnique({
      where: { orgId_email: { orgId, email: normalizeEmail(actor) } },
      select: { id: true },
    });
    const row = await tx.eventGroup.update({
      where: { id },
      data: { finalizedAt: new Date(), finalizedById: actorUser?.id ?? null },
      include: GROUP_EVENT_IDS,
    });
    await logAdminAction(tx, orgId, { actor, action: "finalize_group", target: id });
    return eventGroupToDomain(row);
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return group;
}

export interface NsbeWeekProgress {
  groupName: string;
  attended: number;
  expectedEventCount: number;
  bonusTiers: BonusTier[];
}

/**
 * The FIRST not-yet-complete group, if any — the "NSBE Week: 3 of 5
 * attended" banner. Deliberately shows nothing once the group completes: the
 * spec is explicit that a provisional "+3" that later becomes "+5" (or
 * disappears) is worse than showing nothing, so the banner itself disappears
 * at completion and the real bonus takes over in the point breakdown.
 */
export async function getActiveNsbeWeekProgress(
  orgId: string,
  email: string,
  now: Date = new Date(),
): Promise<NsbeWeekProgress | null> {
  const e = normalizeEmail(email);
  const groups = await prisma.eventGroup.findMany({
    where: { orgId },
    include: GROUP_BONUS_EVENTS,
    orderBy: { createdAt: "desc" },
  });

  for (const g of groups) {
    if (g.events.length === 0) continue;
    const groupInput: GroupBonusInput = {
      events: g.events.map((ev) => ({ eventId: ev.id, status: eventStatusFromDb(ev.status), closesAt: ev.closesAt })),
      bonusTiers: (g.bonusTiers as unknown as BonusTier[] | null) ?? [],
      finalizedAt: g.finalizedAt,
    };
    if (isGroupComplete(groupInput, now)) continue;

    const attended = await prisma.registration.count({
      where: { eventId: { in: g.events.map((ev) => ev.id) }, user: { orgId, email: e, ...LIVE } },
    });
    return { groupName: g.name, attended, expectedEventCount: g.expectedEventCount, bonusTiers: groupInput.bonusTiers };
  }
  return null;
}

export interface GroupAttendanceRow {
  email: string;
  firstName: string;
  lastName: string;
  attendedEventIds: string[];
  bonus: number;
}

/** The per-member attendance matrix (members x this group's events) for /admin/groups — plus each member's CURRENT bonus (0 before completion, per groupBonusFor). */
export async function getGroupAttendanceMatrix(
  orgId: string,
  groupId: string,
  now: Date = new Date(),
): Promise<GroupAttendanceRow[]> {
  const group = await prisma.eventGroup.findFirst({
    where: { id: groupId, orgId },
    include: GROUP_BONUS_EVENTS,
  });
  if (!group) throw new AppError("NOT_FOUND", "Group not found");

  const groupInput: GroupBonusInput = {
    events: group.events.map((e) => ({ eventId: e.id, status: eventStatusFromDb(e.status), closesAt: e.closesAt })),
    bonusTiers: (group.bonusTiers as unknown as BonusTier[] | null) ?? [],
    finalizedAt: group.finalizedAt,
  };
  const eventIds = group.events.map((e) => e.id);

  const [members, registrations] = await Promise.all([
    getMembers(orgId),
    eventIds.length > 0
      ? prisma.registration.findMany({
          where: { eventId: { in: eventIds }, user: LIVE },
          include: { user: { select: { email: true } } },
        })
      : Promise.resolve([]),
  ]);

  const byEmail = new Map<string, string[]>();
  for (const r of registrations) {
    const list = byEmail.get(r.user.email) ?? [];
    list.push(r.eventId);
    byEmail.set(r.user.email, list);
  }

  return members
    .filter((m) => m.role === "general")
    .map((m) => {
      const attendedEventIds = byEmail.get(m.email) ?? [];
      return {
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        attendedEventIds,
        bonus: groupBonusFor(attendedEventIds.map((eventId) => ({ eventId })), groupInput, now),
      };
    });
}

// ---------------------------------------------------------------------------
// Bonus awards (Part 3) — game/competition bonuses, manual awards, and
// materialized monthly champions. GAME_COMPETITION and MONTHLY_CHAMPION are
// capped/deduplicated by PointAward's own @@unique constraints, never by
// application logic — a duplicate throws a real P2002.
// ---------------------------------------------------------------------------

/** One member's live awards (see liveAwardWhere) — a game bonus from a trashed event is left out, same as in every total. */
export async function getPointAwardsForUser(orgId: string, email: string): Promise<PointAward[]> {
  const e = normalizeEmail(email);
  const rows = await prisma.pointAward.findMany({
    where: { ...liveAwardWhere(orgId), user: { email: e, ...LIVE } },
    include: { user: { select: { email: true } } },
    orderBy: { awardedAt: "desc" },
  });
  return rows.map(pointAwardToDomain);
}

/** +1 (or whatever `points` is configured to) per member per event — capped by the (orgId,userId,kind,eventId) unique constraint, not by this loop. Only registrants for the event are valid picks in the admin UI; a non-registrant email here just fails to find a matching user or, if it somehow does, is a data-entry mistake this function doesn't second-guess. */
export async function awardGameBonus(
  orgId: string,
  eventId: string,
  emails: string[],
  points: number,
  reason: string,
  actor: string,
): Promise<{ awarded: string[]; skipped: string[] }> {
  // A game bonus is tied to its event; a trashed event takes its bonuses out
  // of every total (see liveAwardWhere), so it can't be handed new ones.
  const event = await prisma.event.findFirst({ where: { id: eventId, orgId, ...LIVE }, select: { id: true } });
  if (!event) throw new AppError("NOT_FOUND", "Event not found");
  const actorUser = await prisma.user.findUnique({
    where: { orgId_email: { orgId, email: normalizeEmail(actor) } },
    select: { id: true },
  });

  const awarded: string[] = [];
  const skipped: string[] = [];
  for (const rawEmail of emails) {
    const email = normalizeEmail(rawEmail);
    const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email }, ...LIVE } });
    if (!user) {
      skipped.push(email);
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.pointAward.create({
          data: {
            orgId,
            userId: user.id,
            kind: DbAwardKind.GAME_COMPETITION,
            points,
            eventId,
            reason,
            awardedById: actorUser?.id ?? null,
          },
        });
        await logAdminAction(tx, orgId, {
          actor,
          action: "award_game_bonus",
          target: `${eventId}:${email}`,
          detail: String(points),
        });
      });
      awarded.push(email);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        skipped.push(email);
        continue;
      }
      throw err;
    }
  }
  if (awarded.length > 0) invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return { awarded, skipped };
}

export interface CreateManualAwardInput {
  orgId: string;
  email: string;
  points: number;
  reason: string;
  actor: string;
}

export async function createManualAward(input: CreateManualAwardInput): Promise<PointAward> {
  const { orgId } = input;
  const email = normalizeEmail(input.email);
  // Taking points away is an ADJUSTMENT — reasoned, season-scoped, and gated
  // on its own permission (see createPointAdjustment). A negative manual
  // award would be an adjustment that skipped all three; the database refuses
  // one too (PointAward_points_sign_check).
  if (!Number.isInteger(input.points) || input.points < 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A manual award must be a whole number, zero or more. To take points away, use Adjust points on the member's page.",
    );
  }
  const award = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { orgId_email: { orgId, email }, ...LIVE } });
    if (!user) throw new AppError("NOT_FOUND", "Member not found");
    const actorUser = await tx.user.findUnique({
      where: { orgId_email: { orgId, email: normalizeEmail(input.actor) } },
      select: { id: true },
    });
    const row = await tx.pointAward.create({
      data: {
        orgId,
        userId: user.id,
        kind: DbAwardKind.MANUAL,
        points: input.points,
        reason: input.reason,
        awardedById: actorUser?.id ?? null,
      },
      include: { user: { select: { email: true } } },
    });
    await logAdminAction(tx, orgId, {
      actor: input.actor,
      action: "award_manual",
      target: email,
      detail: `${input.points}: ${input.reason}`,
    });
    return pointAwardToDomain(row);
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return award;
}

/** Revoking is the only path from here forward — an award is never deleted, so the audit trail (who granted it, who took it back, why) survives. Standings re-derive on the next read; nothing to backfill. */
export async function revokePointAward(orgId: string, id: string, actor: string, note: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.pointAward.findFirst({ where: { id, ...liveAwardWhere(orgId) } });
    if (!existing) throw new AppError("NOT_FOUND", "Award not found");
    const actorUser = await tx.user.findUnique({
      where: { orgId_email: { orgId, email: normalizeEmail(actor) } },
      select: { id: true },
    });
    await tx.pointAward.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById: actorUser?.id ?? null, revokeNote: note },
    });
    await logAdminAction(tx, orgId, { actor, action: "revoke_award", target: id, detail: note });
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

export async function getMonthlyChampionConfig(orgId: string): Promise<{ minEvents: number }> {
  const raw = await getConfigValue(orgId, "MONTHLY_CHAMPION_MIN_EVENTS", "2");
  const parsed = Number(raw);
  return { minEvents: Number.isFinite(parsed) && parsed > 0 ? parsed : 2 };
}

export interface MonthlyChampionCandidate {
  email: string;
  firstName: string;
  lastName: string;
  count: number;
  /** A trashed member still competes — see calculateMonthlyChampions — so the preview says so rather than naming a hidden account without comment. */
  inTrash: boolean;
}

export interface MonthlyChampionPreview {
  month: string;
  /** What calculateMonthlyChampions would award if run right now. */
  champions: MonthlyChampionCandidate[];
  /** Already-materialized (non-revoked) champions for this month — the "diff" shown before a recalculation. */
  alreadyMaterialized: string[];
}

/** Read-only — the "recalculating shows a diff" confirmation reads this before calculateMonthlyChampions actually writes anything. */
export async function previewMonthlyChampions(
  orgId: string,
  month: string,
  now: Date = new Date(),
): Promise<MonthlyChampionPreview> {
  // Same inputs as calculateMonthlyChampions, trashed members included — see there.
  const [attendance, members, minEventsConfig, existingAwards] = await Promise.all([
    getAttendance(orgId, { includeTrashedMembers: true }),
    getMembers(orgId, { includeDeleted: true }),
    getMonthlyChampionConfig(orgId),
    prisma.pointAward.findMany({
      where: { orgId, kind: DbAwardKind.MONTHLY_CHAMPION, periodMonth: month, revokedAt: null },
      include: { user: { select: { email: true } } },
    }),
  ]);
  const champions = monthlyChampions(attendance, month, minEventsConfig, now);
  const memberByEmail = new Map(members.map((m) => [m.email, m]));
  const trashed = new Set(
    (await prisma.user.findMany({ where: { orgId, deletedAt: { not: null } }, select: { email: true } })).map((u) => u.email),
  );
  return {
    month,
    champions: champions.map((c) => ({
      email: c.email,
      firstName: memberByEmail.get(c.email)?.firstName ?? "",
      lastName: memberByEmail.get(c.email)?.lastName ?? "",
      count: c.count,
      inTrash: trashed.has(c.email),
    })),
    alreadyMaterialized: existingAwards.map((a) => a.user.email),
  };
}

export interface CalculateMonthlyChampionsResult {
  month: string;
  awarded: string[];
  revoked: string[];
  unchanged: boolean;
}

/**
 * Idempotent: re-running for a month whose champion set hasn't changed
 * awards/revokes nothing. If the set DID change (e.g. a category edit
 * changed who qualifies, or a late correction), champions no longer at the
 * max are revoked and new ones are awarded — the (orgId,userId,kind,
 * periodMonth) unique constraint is what actually stops a still-champion
 * member from ever being double-awarded.
 *
 * Trash semantics, both deliberate:
 *   - a trashed EVENT's registrations are excluded (getAttendance always drops
 *     them), so deleting an event CAN change who wins its month — which is why
 *     previewTrashEvent warns when the month has already been calculated, and
 *     why this is never re-run automatically.
 *   - a trashed MEMBER's registrations still count. Trashing hides a person;
 *     it must not hand their month to someone else. So the result is exactly
 *     what it would be without the trash, and a trashed champion is awarded
 *     like anyone else — the award is invisible while they're trashed and
 *     counts again if they're restored. `existing` is unfiltered for the same
 *     reason: a trashed member's award must be found here, or re-running
 *     would try to create it a second time.
 *
 * Point adjustments are not an input at all (monthlyChampions counts
 * registrations only), so no adjustment can change a month's champion.
 */
export async function calculateMonthlyChampions(
  orgId: string,
  month: string,
  points: number,
  actor: string,
  now: Date = new Date(),
): Promise<CalculateMonthlyChampionsResult> {
  const [attendance, minEventsConfig, existing] = await Promise.all([
    getAttendance(orgId, { includeTrashedMembers: true }),
    getMonthlyChampionConfig(orgId),
    prisma.pointAward.findMany({
      where: { orgId, kind: DbAwardKind.MONTHLY_CHAMPION, periodMonth: month, revokedAt: null },
      include: { user: { select: { email: true } } },
    }),
  ]);
  const champions = monthlyChampions(attendance, month, minEventsConfig, now);
  const championEmails = new Set(champions.map((c) => c.email));
  const existingEmails = new Set(existing.map((a) => a.user.email));

  const toAward = champions.filter((c) => !existingEmails.has(c.email));
  const toRevoke = existing.filter((a) => !championEmails.has(a.user.email));

  const actorUser = await prisma.user.findUnique({
    where: { orgId_email: { orgId, email: normalizeEmail(actor) } },
    select: { id: true },
  });

  const awarded: string[] = [];
  const revoked: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const award of toRevoke) {
      await tx.pointAward.update({
        where: { id: award.id },
        data: { revokedAt: now, revokedById: actorUser?.id ?? null, revokeNote: "Superseded by recalculation" },
      });
      revoked.push(award.user.email);
    }
    for (const champion of toAward) {
      // Unfiltered on purpose — a trashed champion is awarded too (see above).
      const user = await tx.user.findUnique({ where: { orgId_email: { orgId, email: champion.email } } });
      if (!user) continue;
      await tx.pointAward.create({
        data: {
          orgId,
          userId: user.id,
          kind: DbAwardKind.MONTHLY_CHAMPION,
          points,
          periodMonth: month,
          reason: `Monthly Engagement Champion — ${month} (${champion.count} events)`,
          awardedById: actorUser?.id ?? null,
        },
      });
      awarded.push(champion.email);
    }
    // Logged on EVERY run, including a no-op: this entry is how the trash bin
    // knows a month has been calculated at all (see getCalculatedMonths) — a
    // month whose calculation found no champion writes no award row to go by.
    await logAdminAction(tx, orgId, {
      actor,
      action: "calculate_monthly_champions",
      target: month,
      detail: `${toAward.length} awarded, ${toRevoke.length} revoked`,
    });
  });

  if (awarded.length > 0 || revoked.length > 0) invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return { month, awarded, revoked, unchanged: toAward.length === 0 && toRevoke.length === 0 };
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface CoreFormConfig {
  majors: string[];
  /** Structured — code/name/color, not the old pipe-delimited string. See lib/houses.ts. */
  houses: House[];
}

/** Config.MAJORS_LIST (still pipe-delimited) and Config.HOUSES_LIST (JSON — see lib/houses.ts), parsed for server-side validation. */
export async function getCoreFormConfig(orgId: string): Promise<CoreFormConfig> {
  const [majorsRaw, housesRaw] = await Promise.all([
    getConfigValue(orgId, "MAJORS_LIST", ""),
    getConfigValue(orgId, "HOUSES_LIST", ""),
  ]);
  const split = (s: string) => s.split("|").map((v) => v.trim()).filter(Boolean);
  return { majors: split(majorsRaw), houses: parseHouses(housesRaw) };
}

/** CoreFormConfig plus the three link targets the core form's descriptions reference, and the current season (drives the dues/national re-ask — see CoreCheckInForm.tsx) — for rendering, not validation. */
export async function getCoreFormUiConfig(
  orgId: string,
): Promise<
  CoreFormConfig & {
    membershipSiteUrl: string;
    houseTestUrl: string;
    nationalMembershipUrl: string;
    currentSeason: string;
  }
> {
  const [core, membershipSiteUrl, houseTestUrl, nationalMembershipUrl, currentSeason] = await Promise.all([
    getCoreFormConfig(orgId),
    getConfigValue(orgId, "MEMBERSHIP_SITE_URL", ""),
    getConfigValue(orgId, "HOUSE_TEST_URL", ""),
    getConfigValue(orgId, "NATIONAL_MEMBERSHIP_URL", DEFAULT_NATIONAL_MEMBERSHIP_URL),
    getConfigValue(orgId, "SEASON", ""),
  ]);
  return { ...core, membershipSiteUrl, houseTestUrl, nationalMembershipUrl, currentSeason };
}

export interface RegisterForEventInput {
  orgId: string;
  /** Must come from the authenticated session — never trust an email in the request body. */
  email: string;
  eventId: string;
  /**
   * The rotating check-in code (see lib/code.ts), re-verified here against
   * receivedAt regardless of what /api/events/[id]/verify-code already said —
   * that endpoint only gates the form's UI, this is the actual boundary.
   */
  code: string;
  /** Answers to the static core form — see lib/core-form.ts. Validated + written back to the User row. */
  core: unknown;
  /** Answers to this event's admin-added extra questions (≤5) — see lib/forms.ts. */
  extra: unknown;
  /**
   * The instant the request arrived at the server — captured by the caller
   * BEFORE any awaits (auth, body parsing), not defaulted in here.
   */
  receivedAt?: Date;
  /** For the per-event brute-force failure log only (see verifyEventCodeOrThrow) — never used to key a rate limit here (the member is already keyed by email/userId at the UX-gate route). */
  ip?: string;
  /**
   * The core fields the client had live at submit (lib/core-form.ts
   * RenderedFieldKey). Only these are validated or written — see planCheckIn.
   * Omitted by a client too old to send it; then an unchanged echo of the
   * stored profile is what gets dropped.
   */
  rendered?: readonly unknown[] | null;
}

export interface RegisterForEventResult {
  pointsAwarded: number;
  total: number;
  rank: number | null;
  /** Whether this member's points count toward standings right now — see lib/points.ts isEligible. */
  eligible: boolean;
  /** Non-null whenever the registrant is currently EBOARD, on ANY event they earn eboard credit for — never persisted, see lib/points.ts eboardAwardFor. */
  eboardPointsAwarded: number | null;
}

export async function registerForEvent(input: RegisterForEventInput): Promise<RegisterForEventResult> {
  const { orgId } = input;
  const email = normalizeEmail(input.email);
  const now = input.receivedAt ?? new Date();

  const [eventRow, user, coreFormConfig, season, eboardPointValue, eboardTrackEnabledRaw] = await Promise.all([
    prisma.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE }, include: EVENT_INCLUDE }),
    prisma.user.findUnique({ where: { orgId_email: { orgId, email }, ...LIVE } }),
    getCoreFormConfig(orgId),
    getConfigValue(orgId, "SEASON", ""),
    getConfigValue(orgId, "EBOARD_POINT_VALUE", "1"),
    getConfigValue(orgId, "EBOARD_TRACK_ENABLED", "true"),
  ]);
  const eboardConfig = { EBOARD_POINT_VALUE: eboardPointValue, EBOARD_TRACK_ENABLED: eboardTrackEnabledRaw === "true" };

  if (!eventRow) throw new AppError("NOT_FOUND", "Event not found");
  const event = eventToDomain(eventRow);

  // 1. The registration window — see lib/points.ts isOpen.
  if (!isOpen(event, now)) {
    throw new AppError("EVENT_CLOSED_DURING_SUBMIT", "This event is no longer open for registration");
  }

  // 2. The rotating check-in code — re-verified here against receivedAt no
  // matter what /api/events/[id]/verify-code already said. That endpoint
  // only gates the form's render; this is the actual security boundary. Also
  // enforces the per-event brute-force lock (see verifyEventCodeOrThrow) —
  // the real security boundary is exactly where a lock has to bite too, or
  // an attacker skips the UX-gate route entirely and this is unlimited.
  await verifyEventCodeOrThrow({ orgId, eventId: event.eventId, code: input.code, now, who: email, ip: input.ip ?? "unknown" });

  if (!user) throw new AppError("UNAUTHENTICATED", "You must be signed in");
  if (statusFromDb(user.status) !== "active") {
    throw new AppError("ACCOUNT_NOT_ACTIVE", "Your account isn't active yet — see the pending page for next steps");
  }

  // Role always comes from the roster, never the client.
  const role: Role = roleFromDb(user.role);

  // EBOARD_ONLY events are 403 for anyone else — server-side defense in
  // depth; the page itself already calls next/navigation's forbidden().
  const canSeeEboardOnly = isEboardOrAdmin(role);
  if (event.audience === "eboard_only" && !canSeeEboardOnly) {
    throw new AppError("FORBIDDEN", "This event is for E-Board only");
  }
  const reduced = event.audience === "eboard_only";

  // 3. Duplicate check — a friendly, explicit early error rather than
  // waiting for the (eventId, userId) unique constraint to reject the write
  // at the very end, after the user has answered every question. The unique
  // constraint stays in place below as the real dedupe guarantee (this read
  // has the usual check-then-write race under concurrent double-submits).
  const existingRegistration = await prisma.registration.findUnique({
    where: { eventId_userId: { eventId: event.eventId, userId: user.id } },
  });
  if (existingRegistration) {
    throw new AppError("ALREADY_REGISTERED", "You have already registered for this event");
  }

  // 4. Core-form validation — writes back to the User row (Part 2/3 of the
  // spec). ONE plan, computed here at submit for this user and this event
  // (lib/core-form.ts planCheckIn), from the same getMissingFields the form
  // rendered from: only what the member was shown and answered is validated
  // or written, and only what they were shown can be required. EBOARD_ONLY
  // events go through the same path — getMissingFields stops at the name
  // fields for them — rather than a second schema. A Config.SEASON bump
  // re-arms classification/major (via profileSeason) and dues/national (via
  // membershipSeason) with no script.
  const rendered = input.rendered ?? null;
  const plan = planCheckIn({
    user: userToMember(user),
    event,
    config: { SEASON: season },
    answers: input.core,
    rendered,
  });
  if (plan.requiredButNotRendered.length > 0) {
    logRequiredButNotRendered({ orgId, userId: user.id, eventId: event.eventId, fields: plan.requiredButNotRendered, rendered });
  }
  // What this submission actually ASKED — missing and shown. A question the
  // member wasn't shown is treated exactly like one already answered: nothing
  // written, the stored value snapshotted.
  const asked = plan.required;
  const duesAlreadyReported = !asked.has("duesPaid");
  const nationalAlreadyReported = !asked.has("nationalMember");

  const fields = (await prisma.formField.findMany({ where: { eventId: event.eventId }, orderBy: { order: "asc" } })).map(
    formFieldToDomain,
  );
  // Every 422 below is logged with what the client rendered — see lib/checkin-diagnostics.ts.
  const userId = user.id;
  function rejected(err: unknown): never {
    if (err instanceof AppError && err.code === "VALIDATION_FAILED") {
      logCheckInRejection({
        orgId,
        userId,
        eventId: event.eventId,
        fieldErrors: err.fieldErrors ?? {},
        message: err.message,
        rendered,
        missing: plan.missing,
        extraFieldKeys: fields.map((f) => f.fieldKey),
      });
    }
    throw err;
  }

  let validated: CoreFormAnswers;
  try {
    validated = validateCoreAnswers(
      { role, majors: coreFormConfig.majors, houses: coreFormConfig.houses, missing: asked },
      plan.answers,
    );
  } catch (err) {
    rejected(err);
  }
  const fullCore = reduced ? null : validated;
  const reducedCore = reduced ? { firstName: validated.firstName, lastName: validated.lastName } : null;

  // A newly-submitted House/Resume file must belong to this user — never trust a client-supplied fileId blindly.
  if (fullCore) {
    const fileIdsToCheck = [
      fullCore.houseProofFileId,
      fullCore.resumeAction === "upload" ? fullCore.resumeFileId : undefined,
    ].filter((id): id is string => Boolean(id));
    if (fileIdsToCheck.length > 0) {
      const owned = await prisma.uploadedFile.count({ where: { id: { in: fileIdsToCheck }, userId: user.id, orgId } });
      if (owned !== fileIdsToCheck.length) {
        rejected(new AppError("VALIDATION_FAILED", "One of your uploaded files couldn't be found. Try uploading again."));
      }
    }
  }

  // 5. Extra-question validation — unchanged from before, still ≤5 FormField rows.
  let extraAnswers: ReturnType<typeof validateAnswers>;
  try {
    extraAnswers = validateAnswers(fields, input.extra);
  } catch (err) {
    rejected(err);
  }

  // 6. Points. Member track: always the full amount regardless of
  // eligibility (see lib/points.ts isEligible) — this is a historical
  // snapshot only (see AttendanceRecord.pointsAwarded); the leaderboard
  // re-derives from the live category/override on every read instead. E-Board
  // track: entirely separate scoring, never stored — see lib/points.ts
  // eboardAwardFor. This applies on ANY event an EBOARD member attends, not
  // just EBOARD_ONLY ones (a GBM counts toward the internal track too, per
  // Part 3's own example).
  const pointsAwarded = memberPointsFor({ role }, event, event.category);
  const eboardPointsAwarded = canSeeEboardOnly ? eboardAwardFor(role, event.category, eboardConfig) : null;

  // 7. Every check passed — write. The (eventId, userId) unique constraint is
  // still the actual dedupe guarantee (belt and suspenders on top of the
  // explicit check above) — it closes the check-then-write race that check
  // alone can't.
  // effectiveDuesPaid/effectiveNationalMember fold in the "already reported"
  // case (question wasn't asked, so nothing was submitted — the true current
  // value is what duesAlreadyReported/nationalAlreadyReported already proved).
  // "Already reported" reads the stored value rather than assuming true:
  // getMissingFields also stops asking when the questions don't apply to
  // this account at all (an ADMIN — see its "who you are" reduction), and
  // an unasked question must snapshot what's actually on file, not a yes
  // nobody ever gave. For a GENERAL/EBOARD member the two are identical,
  // since dues/national only leave the missing set once they're true.
  const effectiveDuesPaid = fullCore
    ? duesAlreadyReported
      ? user.duesPaidReported === true
      : fullCore.duesPaid === true
    : null;
  const effectiveNationalMember = fullCore
    ? nationalAlreadyReported
      ? user.nationalMemberReported === true
      : fullCore.nationalMember === true
    : null;
  // Stamp membershipSeason only on a transition to true THIS submission —
  // answering "No" (or the question not being asked at all) never touches it.
  const stampSeason =
    fullCore !== null &&
    ((!duesAlreadyReported && fullCore.duesPaid === true) || (!nationalAlreadyReported && fullCore.nationalMember === true));
  // Same rule, for classification/major -> profileSeason: only stamped when
  // one of them was actually asked (and therefore submitted) this time.
  const stampProfileSeason = fullCore !== null && (fullCore.classification !== undefined || fullCore.major !== undefined);

  const answerRows = serializeAnswers(fields, extraAnswers);
  let eligible = false;
  try {
    await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: fullCore
          ? {
              firstName: fullCore.firstName,
              lastName: fullCore.lastName,
              // Same "only in the payload when it was asked" rule as
              // classification/major below — omit the key entirely
              // otherwise so an account that was never asked (an ADMIN)
              // doesn't have its existing value blanked.
              ...(fullCore.studentId !== undefined ? { studentId: fullCore.studentId } : {}),
              ...(fullCore.phone !== undefined ? { phone: fullCore.phone } : {}),
              ...(fullCore.personalEmail !== undefined ? { personalEmail: fullCore.personalEmail } : {}),
              ...(fullCore.tshirtSize !== undefined ? { tshirtSize: shirtSizeToDb(fullCore.tshirtSize) } : {}),
              // classification/major are only in the payload when
              // getMissingFields asked for them — omit the key entirely
              // otherwise so the existing (already-current-for-this-season)
              // value is left untouched.
              ...(fullCore.classification !== undefined ? { classification: classificationToDb(fullCore.classification) } : {}),
              ...(fullCore.major !== undefined
                ? {
                    major: fullCore.major === "Other" ? fullCore.majorOther ?? null : fullCore.major,
                    majorOther: fullCore.major === "Other" ? fullCore.majorOther ?? null : null,
                  }
                : {}),
              ...(stampProfileSeason ? { profileSeason: season } : {}),
              // Dues/national are only in the payload when the question was
              // actually asked (Part 2's persistent re-ask) — omit the key
              // entirely otherwise so the existing DB value (already true)
              // is left untouched.
              // A "yes" here clears a previous revoke for the same reason
              // setDuesReported does: it is a new claim, and leaving the
              // stale revoke stamp on the row would hide it from the audit
              // queue forever (see lib/claim-state.ts).
              ...(!duesAlreadyReported
                ? {
                    duesPaidReported: fullCore.duesPaid,
                    duesReportedAt: now,
                    ...(fullCore.duesPaid === true
                      ? { duesRevokedAt: null, duesRevokedById: null, duesRevokedNote: null }
                      : {}),
                  }
                : {}),
              ...(!nationalAlreadyReported
                ? {
                    nationalMemberReported: fullCore.nationalMember,
                    ...(fullCore.nationalMember === true
                      ? { nationalRevokedAt: null, nationalRevokedById: null, nationalRevokedNote: null }
                      : {}),
                  }
                : {}),
              // Independent of the national answer in both directions: the
              // ID is written whenever the form submitted one (blank means
              // the member cleared it), and answering No never wipes it.
              ...(fullCore.nsbeMembershipId !== undefined
                ? { nsbeMembershipId: fullCore.nsbeMembershipId || null }
                : {}),
              ...(stampSeason ? { membershipSeason: season } : {}),
              // A House and its screenshot are written TOGETHER, or not at
              // all — see buildCoreFormSchema's house superRefine (Part 1):
              // a skip (or a partial submission the schema didn't require)
              // leaves house untouched, same as answering "No" used to. An
              // E-Board member has no screenshot to pair it with and is
              // verified on selection instead — the same houseSelfVerifies
              // rule setHouseAssignment applies, applied here because this
              // write is part of the Registration's own transaction.
              ...(user.houseVerifiedAt !== null || !fullCore.house
                ? {}
                : houseSelfVerifies(role)
                  ? {
                      house: fullCore.house,
                      houseProofFileId: null,
                      houseVerifiedAt: now,
                      houseVerifiedById: HOUSE_SYSTEM_VERIFIER,
                    }
                  : fullCore.houseProofFileId
                    ? { house: fullCore.house, houseProofFileId: fullCore.houseProofFileId }
                    : {}),
              ...(fullCore.resumeAction === "upload" && fullCore.resumeFileId
                ? { resumeFileId: fullCore.resumeFileId, resumeUpdatedAt: now, resumeConsentAt: now }
                : {}),
            }
          : // Reduced form (Part 6) — confirms identity only, nothing else on the User row changes.
            { firstName: reducedCore!.firstName, lastName: reducedCore!.lastName },
      });
      eligible = fullCore ? isEligible(userToMember(updatedUser), season) : false;

      const registration = await tx.registration.create({
        data: {
          eventId: event.eventId,
          userId: user.id,
          pointsAwarded,
          roleAtTime: roleToDb(role),
          source: DbSource.FORM,
          // Reduced-form (EBOARD_ONLY) registrations leave these null — the
          // core form never asked, same precedent as guest registrations.
          // coreFormVersion is still stamped either way; that combination
          // (version present, snapshot fields null) is what makes a reduced
          // submission distinguishable in exports without a new column.
          // Snapshotted from updatedUser (the post-write, always-current
          // value) rather than fullCore directly — classification/major
          // are only in fullCore when this submission actually asked for
          // them (see stampProfileSeason above).
          classificationAtTime: fullCore ? updatedUser.classification : null,
          majorAtTime: fullCore ? updatedUser.major : null,
          duesReportedAtTime: effectiveDuesPaid,
          nationalReportedAtTime: effectiveNationalMember,
          coreFormVersion: CORE_FORM_VERSION,
          eligibleAtTime: fullCore ? eligible : null,
        },
      });
      const entries = Object.entries(answerRows);
      if (entries.length > 0) {
        await tx.answer.createMany({
          data: entries.map(([fieldKey, value]) => ({ registrationId: registration.id, fieldKey, value })),
        });
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("ALREADY_REGISTERED", "You have already registered for this event");
    }
    throw err;
  }

  invalidateStandings(orgId, season);

  // 8. Derive the result fresh — rank depends on everyone else's standing too.
  const summary = await getMemberSummary(orgId, email);
  return { pointsAwarded, total: summary.points, rank: summary.rank, eligible, eboardPointsAwarded };
}

export interface RegisterGuestInput {
  orgId: string;
  eventId: string;
  firstName: string;
  lastName: string;
  email: string;
  affiliation: string;
  phone?: string;
  /** Same rotating code as member check-in (see lib/code.ts) — guests have no account, so this is the ONLY thing standing between a forwarded link and a fraudulent check-in. */
  code: string;
  extra: unknown;
  receivedAt?: Date;
  /** For the per-event brute-force failure log only (see verifyEventCodeOrThrow) — the guest UX-gate action already keys its own per-IP limiter separately. */
  ip?: string;
}

export interface RegisterGuestResult {
  pointsAwarded: 0;
}

/**
 * Guests never authenticate (see the guest_pass cookie in src/proxy.ts,
 * checked only against /guest/*) — find-or-create a lightweight GUEST-role
 * User by (orgId, email) so a returning guest doesn't get duplicated, then log
 * a zero-point Registration. passwordHash is left null: not a weak/unguessable
 * hash, no hash at all, so lib/auth.ts authorize() can reject role GUEST /
 * null passwordHash outright rather than relying on a compare ever failing.
 * Guests never appear in standings (computeStandings filters to role general).
 */
export async function registerGuest(input: RegisterGuestInput): Promise<RegisterGuestResult> {
  const { orgId } = input;
  const email = normalizeEmail(input.email);
  const now = input.receivedAt ?? new Date();

  const fieldErrors: Record<string, string> = {};
  if (!input.firstName.trim()) fieldErrors.firstName = "Required";
  if (!input.lastName.trim()) fieldErrors.lastName = "Required";
  if (!email || !email.includes("@")) fieldErrors.email = "Enter a valid email";
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError("VALIDATION_FAILED", "Check the highlighted fields.", { fieldErrors });
  }

  const eventRow = await prisma.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
  if (!eventRow) throw new AppError("NOT_FOUND", "Event not found");
  const event = eventToDomain(eventRow);
  // EBOARD_ONLY events aren't for guests — the page already excludes them from the feed; this is defense in depth for a direct POST.
  if (event.audience === "eboard_only") throw new AppError("NOT_FOUND", "Event not found");
  if (!isOpen(event, now)) {
    throw new AppError("EVENT_CLOSED_DURING_SUBMIT", "This event is no longer open for registration");
  }
  // Real security boundary — same per-event brute-force lock as
  // registerForEvent (see verifyEventCodeOrThrow); guests have no account to
  // key a per-member limiter by, so this is the only thing standing between
  // a scripted attacker and an unlimited number of guest check-ins here.
  await verifyEventCodeOrThrow({ orgId, eventId: event.eventId, code: input.code, now, who: email, ip: input.ip ?? "unknown" });

  const fields = (await prisma.formField.findMany({ where: { eventId: event.eventId }, orderBy: { order: "asc" } })).map(
    formFieldToDomain,
  );
  const extraAnswers = validateAnswers(fields, input.extra);
  const answerRows = serializeAnswers(fields, extraAnswers);

  // A trashed row still owns its email, and the upsert below would happily
  // attach a registration to it — refuse instead, without saying why.
  const existing = await prisma.user.findUnique({ where: { orgId_email: { orgId, email } }, select: { deletedAt: true } });
  if (existing?.deletedAt) {
    throw new AppError("FORBIDDEN", "This email can't be used to check in. See an E-Board member.");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { orgId_email: { orgId, email } },
        update: {},
        create: {
          orgId,
          email,
          passwordHash: null,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          membership: input.affiliation.trim() || null,
          phone: input.phone?.trim() || null,
          role: DbRole.GUEST,
          status: DbUserStatus.ACTIVE,
        },
      });
      const registration = await tx.registration.create({
        data: {
          eventId: event.eventId,
          userId: user.id,
          pointsAwarded: 0,
          roleAtTime: DbRole.GUEST,
          source: DbSource.FORM,
        },
      });
      const entries = Object.entries(answerRows);
      if (entries.length > 0) {
        await tx.answer.createMany({
          data: entries.map(([fieldKey, value]) => ({ registrationId: registration.id, fieldKey, value })),
        });
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("ALREADY_REGISTERED", "You've already checked in to this event");
    }
    throw err;
  }

  return { pointsAwarded: 0 };
}

export interface CreateEventInput {
  orgId: string;
  name: string;
  categoryId: string;
  groupId?: string | null;
  slug?: string;
  date?: Date | null;
  location?: string;
  description?: string;
  points?: number | null;
  durationMinutes?: number | null;
  audience?: Audience;
  house?: EventHouseFlagsInput;
  createdBy: string;
}

/** The four House Scoring checkboxes — see prisma/schema.prisma Event and lib/house-repo.ts. */
export interface EventHouseFlagsInput {
  countsForShowUp: boolean;
  countsForRepYourHouse: boolean;
  countsForMonthlyHouse: boolean;
  isHouseCompetition: boolean;
}

export async function createEvent(input: CreateEventInput): Promise<Event> {
  const { orgId } = input;
  const defaultDuration = Number(await getConfigValue(orgId, "DEFAULT_EVENT_DURATION", "20"));
  return prisma.$transaction(async (tx) => {
    const category = await tx.eventCategory.findFirst({ where: { id: input.categoryId, orgId } });
    if (!category) throw new AppError("NOT_FOUND", "Category not found");

    const base = slugify(input.slug || `${input.name}-${(input.date ?? new Date()).getFullYear()}`);
    const slug = await uniqueSlug(tx, orgId, base);
    const creator = await tx.user.findUnique({
      where: { orgId_email: { orgId, email: normalizeEmail(input.createdBy) } },
      select: { id: true },
    });

    const row = await tx.event.create({
      data: {
        orgId,
        slug,
        name: input.name,
        categoryId: category.id,
        groupId: input.groupId ?? null,
        date: input.date ?? new Date(),
        location: input.location || null,
        description: input.description || null,
        pointsOverride: input.points ?? null,
        status: DbEventStatus.DRAFT,
        durationMinutes: input.durationMinutes ?? defaultDuration,
        audience: audienceToDb(input.audience ?? "all"),
        ...(input.house ?? {}),
        createdById: creator?.id ?? null,
      },
      include: EVENT_INCLUDE,
    });
    await logAdminAction(tx, orgId, { actor: input.createdBy, action: "create_event", target: row.id, detail: input.name });
    return eventToDomain(row);
  });
}

export interface UpdateEventInput {
  orgId: string;
  eventId: string;
  name?: string;
  categoryId?: string;
  groupId?: string | null;
  slug?: string;
  date?: Date | null;
  location?: string;
  description?: string;
  points?: number | null;
  durationMinutes?: number | null;
  audience?: Audience;
  house?: EventHouseFlagsInput;
  actor: string;
}

/** Edits an event's definition. Used for Draft/Scheduled events, before or between open windows — never touches Status/OpensAt/ClosesAt/OpenedBy. */
export async function updateEvent(input: UpdateEventInput): Promise<Event> {
  const { orgId } = input;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE } });
    if (!existing) throw new AppError("NOT_FOUND", "Event not found");

    if (input.categoryId !== undefined) {
      const category = await tx.eventCategory.findFirst({ where: { id: input.categoryId, orgId } });
      if (!category) throw new AppError("NOT_FOUND", "Category not found");
    }
    if (input.groupId) {
      const group = await tx.eventGroup.findFirst({ where: { id: input.groupId, orgId } });
      if (!group) throw new AppError("NOT_FOUND", "Group not found");
    }

    const data: Prisma.EventUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.categoryId !== undefined) data.category = { connect: { id: input.categoryId } };
    if (input.groupId !== undefined) data.group = input.groupId ? { connect: { id: input.groupId } } : { disconnect: true };
    if (input.date !== undefined && input.date !== null) data.date = input.date;
    if (input.location !== undefined) data.location = input.location || null;
    if (input.description !== undefined) data.description = input.description || null;
    if (input.points !== undefined) data.pointsOverride = input.points;
    if (input.durationMinutes !== undefined) {
      data.durationMinutes = input.durationMinutes ?? Number(await getConfigValue(orgId, "DEFAULT_EVENT_DURATION", "20"));
    }
    if (input.audience !== undefined) data.audience = audienceToDb(input.audience);
    if (input.house) {
      const h = input.house;
      Object.assign(data, h);
      const changed =
        h.countsForShowUp !== existing.countsForShowUp ||
        h.countsForRepYourHouse !== existing.countsForRepYourHouse ||
        h.countsForMonthlyHouse !== existing.countsForMonthlyHouse ||
        h.isHouseCompetition !== existing.isHouseCompetition;
      if (changed) {
        // A flag edit after the fact: the event's own House awards are due
        // again (the sweep recomputes them), and a calculated month that
        // contains it is flagged — never recalculated here.
        data.houseChangedAt = new Date();
        if (existing.houseScoredAt) data.houseScoringStale = true;
      }
    }
    if (input.slug !== undefined && input.slug.trim() !== "") {
      data.slug = await uniqueSlug(tx, orgId, slugify(input.slug), existing.id);
    }

    const row = await tx.event.update({ where: { id: input.eventId }, data, include: EVENT_INCLUDE });
    await logAdminAction(tx, orgId, { actor: input.actor, action: "update_event", target: input.eventId });
    return eventToDomain(row);
  });
}

export async function cancelEvent(orgId: string, eventId: string, actor: string): Promise<Event> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({ where: { id: eventId, orgId, ...LIVE } });
    if (!existing) throw new AppError("NOT_FOUND", "Event not found");
    const row = await tx.event.update({ where: { id: eventId }, data: { status: DbEventStatus.CANCELED }, include: EVENT_INCLUDE });
    await logAdminAction(tx, orgId, { actor, action: "cancel_event", target: eventId });
    return eventToDomain(row);
  });
}

export interface OpenEventNowInput {
  orgId: string;
  eventId: string;
  openedBy: string;
  durationMinutes?: number;
  now?: Date;
}

const DEFAULT_OPEN_DURATION_MINUTES = 60;

export async function openEventNow(input: OpenEventNowInput): Promise<Event> {
  const { orgId } = input;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE } });
    if (!existing) throw new AppError("NOT_FOUND", "Event not found");

    const now = input.now ?? new Date();
    const durationMinutes = input.durationMinutes ?? DEFAULT_OPEN_DURATION_MINUTES;
    const closesAt = new Date(now.getTime() + durationMinutes * 60_000);
    const opener = await tx.user.findUnique({
      where: { orgId_email: { orgId, email: normalizeEmail(input.openedBy) } },
      select: { id: true },
    });

    const row = await tx.event.update({
      where: { id: input.eventId },
      data: {
        status: DbEventStatus.SCHEDULED,
        opensAt: now,
        closesAt,
        durationMinutes,
        openedById: opener?.id ?? null,
        openedAt: now,
      },
      include: EVENT_INCLUDE,
    });
    await logAdminAction(tx, orgId, { actor: input.openedBy, action: "open_event", target: input.eventId });
    return eventToDomain(row);
  });
}

export interface ExtendEventInput {
  orgId: string;
  eventId: string;
  extraMinutes: number;
  actor: string;
  now?: Date;
}

export async function extendEvent(input: ExtendEventInput): Promise<Event> {
  const { orgId } = input;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
    if (!existing) throw new AppError("NOT_FOUND", "Event not found");

    const event = eventToDomain(existing);
    const now = input.now ?? new Date();
    const base = event.closesAt && event.closesAt.getTime() > now.getTime() ? event.closesAt : now;
    const newClosesAt = new Date(base.getTime() + input.extraMinutes * 60_000);
    const newDuration =
      event.opensAt !== null
        ? Math.round((newClosesAt.getTime() - event.opensAt.getTime()) / 60_000)
        : input.extraMinutes;

    const row = await tx.event.update({
      where: { id: input.eventId },
      data: { closesAt: newClosesAt, durationMinutes: newDuration },
      include: EVENT_INCLUDE,
    });
    await logAdminAction(tx, orgId, {
      actor: input.actor,
      action: "extend_event",
      target: input.eventId,
      detail: `+${input.extraMinutes} min`,
    });
    return eventToDomain(row);
  });
}

export interface CloseEventNowInput {
  orgId: string;
  eventId: string;
  actor: string;
  now?: Date;
}

export async function closeEventNow(input: CloseEventNowInput): Promise<Event> {
  const { orgId } = input;
  const now = input.now ?? new Date();
  const closed = await prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE } });
    if (!existing) throw new AppError("NOT_FOUND", "Event not found");
    const row = await tx.event.update({ where: { id: input.eventId }, data: { closesAt: now }, include: EVENT_INCLUDE });
    await logAdminAction(tx, orgId, { actor: input.actor, action: "close_event", target: input.eventId });
    return row;
  });
  // House scoring on close. A window that simply runs out is picked up by the
  // lazy sweep instead (lib/house-repo.ts runHouseScoringSweep); a failure
  // here leaves the event unscored for the sweep and never fails the close.
  if (closed.status === DbEventStatus.SCHEDULED && (closed.countsForShowUp || closed.countsForRepYourHouse)) {
    try {
      await processEventHouseScoring(orgId, closed.id, { actor: input.actor, now, trigger: "closed" });
    } catch (err) {
      console.error("[houses] scoring on close failed", { eventId: closed.id, err });
    }
  }
  return eventToDomain(closed);
}

export interface ReopenEventInput {
  orgId: string;
  eventId: string;
  reopenedBy: string;
  durationMinutes?: number;
  now?: Date;
}

/**
 * Reopens a closed event for more registrations. Allowed at any time, but
 * always audited: the prior open window is written to AdminLog before it's
 * overwritten on the Event row.
 */
export async function reopenEvent(input: ReopenEventInput): Promise<Event> {
  const { orgId } = input;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
    if (!existing) throw new AppError("NOT_FOUND", "Event not found");
    const prior = eventToDomain(existing);

    const now = input.now ?? new Date();
    const durationMinutes = input.durationMinutes ?? DEFAULT_OPEN_DURATION_MINUTES;
    const closesAt = new Date(now.getTime() + durationMinutes * 60_000);
    const reopener = await tx.user.findUnique({
      where: { orgId_email: { orgId, email: normalizeEmail(input.reopenedBy) } },
      select: { id: true },
    });

    const row = await tx.event.update({
      where: { id: input.eventId },
      data: {
        status: DbEventStatus.SCHEDULED,
        opensAt: now,
        closesAt,
        durationMinutes,
        openedById: reopener?.id ?? null,
        openedAt: now,
        reopenNote: prior.opensAt && prior.closesAt ? `${prior.opensAt.toISOString()} – ${prior.closesAt.toISOString()}` : null,
      },
      include: EVENT_INCLUDE,
    });

    const priorWindow =
      prior.opensAt && prior.closesAt
        ? `${prior.opensAt.toISOString()} – ${prior.closesAt.toISOString()}`
        : "no prior window recorded";
    await logAdminAction(tx, orgId, {
      actor: input.reopenedBy,
      action: "reopen_event",
      target: input.eventId,
      detail: `Previous window: ${priorWindow}`,
    });
    return eventToDomain(row);
  });
}

export interface AddManualAttendanceInput {
  orgId: string;
  eventId: string;
  email: string;
  role?: Role;
  points?: number;
  source?: string;
  note: string;
  addedBy: string;
  now?: Date;
}

export async function addManualAttendance(input: AddManualAttendanceInput): Promise<AttendanceRecord> {
  const { orgId } = input;
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();

  const [eventRow, user] = await Promise.all([
    prisma.event.findFirst({ where: { id: input.eventId, orgId, ...LIVE }, include: EVENT_INCLUDE }),
    prisma.user.findUnique({ where: { orgId_email: { orgId, email }, ...LIVE } }),
  ]);
  if (!eventRow) throw new AppError("NOT_FOUND", "Event not found");
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  const event = eventToDomain(eventRow);

  const role: Role = input.role ?? roleFromDb(user.role);
  const pointsAwarded = input.points ?? memberPointsFor({ role }, event, event.category);

  try {
    const record = await prisma.$transaction(async (tx) => {
      const registration = await tx.registration.create({
        data: {
          eventId: event.eventId,
          userId: user.id,
          pointsAwarded,
          roleAtTime: roleToDb(role),
          source: DbSource.MANUAL,
          note: input.note,
          createdAt: now,
        },
      });
      await logAdminAction(tx, orgId, {
        actor: input.addedBy,
        action: "add_attendance",
        target: `${event.eventId}:${email}`,
        detail: input.note,
      });
      return {
        id: registration.id,
        timestamp: registration.createdAt,
        eventId: event.eventId,
        email,
        role,
        pointsAwarded,
        source: "manual",
        note: input.note,
        eventPointsOverride: event.points,
        closesAt: event.closesAt,
        category: event.category,
      };
    });
    invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
    // House scoring is a separate track fed by the same Registration row — a
    // late add recomputes the event's House awards if it was already scored.
    await onHouseAttendanceChanged(orgId, event.eventId);
    return record;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("ALREADY_REGISTERED", "This member is already logged for this event");
    }
    throw err;
  }
}

export async function deleteAttendance(orgId: string, id: string, actor: string): Promise<void> {
  const eventId = await prisma.$transaction(async (tx) => {
    const row = await tx.registration.findFirst({
      where: { id, ...liveRegistrationWhere(orgId) },
      include: { user: { select: { email: true } } },
    });
    if (!row) throw new AppError("NOT_FOUND", "Attendance record not found");
    await tx.registration.delete({ where: { id } });
    await logAdminAction(tx, orgId, {
      actor,
      action: "delete_attendance",
      target: `${row.eventId}:${row.user.email}`,
    });
    return row.eventId;
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  await onHouseAttendanceChanged(orgId, eventId);
}

/**
 * Demoting the org's last ADMIN would permanently lock everyone out of
 * /admin/settings, join codes, and every other ADMIN-only surface — there's
 * no path back in without direct DB access. Blocked regardless of how many
 * ADMIN accounts exist today (seven pre-seeded officers included — see
 * prisma/seed.ts seedHardcodedAdmins): this guards the case they ever get
 * demoted down to one.
 */
export async function setMemberRole(orgId: string, email: string, role: Role, actor: string): Promise<Member> {
  const e = normalizeEmail(email);
  const member = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
    if (!existing) throw new AppError("NOT_FOUND", "Member not found");

    if (existing.role === DbRole.ADMIN && role !== "admin") {
      const otherAdmins = await tx.user.count({ where: { orgId, role: DbRole.ADMIN, id: { not: existing.id }, ...LIVE } });
      if (otherAdmins === 0) {
        throw new AppError("LAST_ADMIN", "Can't remove the last Admin — promote another account first.");
      }
    }

    const row = await tx.user.update({ where: { id: existing.id }, data: { role: roleToDb(role) } });
    await logAdminAction(tx, orgId, { actor, action: "change_role", target: e, detail: role });
    return userToMember(row);
  });
  // A role change moves a member on or off the GENERAL board (see
  // computeStandings' role filter) or on/off the internal E-Board track —
  // either way the cached standings are now wrong for this member.
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return member;
}

/** Displayed on the internal E-Board leaderboard only — meaningless for a non-EBOARD row, but not blocked (a demoted officer keeps their title on record). */
export async function setEboardPosition(orgId: string, email: string, position: string, actor: string): Promise<Member> {
  const e = normalizeEmail(email);
  return prisma.$transaction(async (tx) => {
    try {
      const row = await tx.user.update({
        where: { orgId_email: { orgId, email: e }, ...LIVE },
        data: { eboardPosition: position.trim() || null },
      });
      await logAdminAction(tx, orgId, { actor, action: "set_eboard_position", target: e, detail: position });
      return userToMember(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new AppError("NOT_FOUND", "Member not found");
      }
      throw err;
    }
  });
}

export async function setMemberStatus(orgId: string, email: string, status: UserStatus, actor: string): Promise<Member> {
  const e = normalizeEmail(email);
  return prisma.$transaction(async (tx) => {
    try {
      const row = await tx.user.update({ where: { orgId_email: { orgId, email: e }, ...LIVE }, data: { status: statusToDb(status) } });
      await logAdminAction(tx, orgId, { actor, action: "change_status", target: e, detail: status });
      return userToMember(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new AppError("NOT_FOUND", "Member not found");
      }
      throw err;
    }
  });
}

export async function approveMember(orgId: string, email: string, actor: string): Promise<Member> {
  return setMemberStatus(orgId, email, "active", actor);
}

/** Rejecting suspends rather than deletes — preserves the row/audit trail. */
export async function rejectMember(orgId: string, email: string, actor: string): Promise<Member> {
  return setMemberStatus(orgId, email, "suspended", actor);
}

export interface CreateMemberAccountResult {
  member: Member;
  /** Plaintext, for the admin's screen. An admin can show it again later with "Resend code" (revealSetupCode) until the member sets a password. */
  setupCode: string;
}

/**
 * E-Board/Admin provisioning for someone whose self-signup is broken. The
 * account starts pending: passwordHash null, a sealed setup code in setupCode,
 * mustChangePassword true (see lib/setup-code.ts, lib/credentials.ts). Status
 * is ACTIVE immediately: an officer-created account is already vouched for,
 * unlike a self-signup awaiting approval.
 */
export async function createMemberAccount(
  orgId: string,
  email: string,
  firstName: string,
  lastName: string,
  role: Role,
  actor: string,
): Promise<CreateMemberAccountResult> {
  const e = normalizeEmail(email);
  const setupCode = generateSetupCode();

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.user.create({
        data: {
          orgId,
          email: e,
          passwordHash: null,
          setupCode: sealSetupCode(setupCode),
          setupCodeIssuedAt: new Date(),
          setupCodeIssuedById: await userIdFor(tx, orgId, actor),
          firstName,
          lastName,
          role: roleToDb(role),
          status: DbUserStatus.ACTIVE,
          mustChangePassword: true,
        },
      });
      await logAdminAction(tx, orgId, { actor, action: "create_member", target: e, detail: role });
      return { member: userToMember(row), setupCode };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A trashed account still owns its email and is invisible on the roster
      // — say where it is, or the admin is told about a member they can't find.
      const existing = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e } }, select: { deletedAt: true } });
      throw new AppError(
        "ALREADY_REGISTERED",
        existing?.deletedAt
          ? "An account with this email is in the trash — restore it from /admin/trash instead."
          : "A member with this email already exists",
      );
    }
    throw err;
  }
}

/** Sets a real password: writes the hash, clears mustChangePassword. */
export async function setPassword(orgId: string, email: string, plain: string): Promise<void> {
  const e = normalizeEmail(email);
  // Hash BEFORE the write — bcrypt at cost 12 takes a couple hundred ms.
  const hash = await hashPassword(plain);

  try {
    await prisma.user.update({
      where: { orgId_email: { orgId, email: e } },
      // The setup code goes in the same write: a real password and a live
      // code must never coexist (User_single_credential_check).
      data: { passwordHash: hash, mustChangePassword: false, setupCode: null, setupCodeIssuedAt: null, setupCodeIssuedById: null },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new AppError("NOT_FOUND", "Member not found");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Double-submit protection for actions that must not run twice.
//
// A disabled confirm button is a UX affordance, not a guarantee: a slow
// network plus an impatient admin still produces two requests. For an action
// that GENERATES A CREDENTIAL that is not a cosmetic problem — a second
// rotation silently invalidates the join code the first one just put on
// screen, and the admin hands out a code that no longer works.
//
// So the client mints a requestToken per confirm-dialog opening (see
// components/ui/ConfirmDialog.tsx) and the action claims it in the SAME
// transaction as its work. Postgres' unique index does the rest: the second
// transaction blocks on the index, fails, and rolls its own work back with it.
// Concurrency-safe in a way an "was there a recent one?" SELECT is not.
//
// Password reset does NOT use this: it collapses repeats per member instead,
// under a row lock, and hands the repeat the SAME code rather than an error —
// see resetPassword below.
// ---------------------------------------------------------------------------

/**
 * Must be the FIRST statement in the transaction. A unique violation aborts
 * the whole Postgres transaction (Prisma does not wrap statements in
 * savepoints), which is precisely the desired behaviour: no claim, no work.
 * Callers translate the thrown P2002 with isDuplicateRequest below.
 */
async function claimRequestToken(tx: Tx, orgId: string, scope: string, token: string, target?: string): Promise<void> {
  await tx.requestClaim.create({ data: { orgId, scope, token, target: target ?? null } });
}

/** True when a transaction failed because its request token was already claimed — i.e. this submission is a repeat. */
export function isDuplicateRequest(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const meta = err.meta as { modelName?: string; target?: unknown } | undefined;
  if (meta?.modelName === "RequestClaim") return true;
  return JSON.stringify(meta?.target ?? "").includes("RequestClaim");
}

// ---------------------------------------------------------------------------
// Setup codes — admin reset, "Resend code", and the account-state panel on
// /admin/members/[id]. lib/setup-code.ts owns how a code is stored and
// compared; lib/credentials.ts owns how sign-in uses it.
// ---------------------------------------------------------------------------

/**
 * How long a repeat reset of the same member BY THE SAME ADMIN returns the code
 * that was just issued instead of replacing it. Long enough to swallow a double
 * click, a retried request or a second tab; short enough that a deliberate
 * "that code didn't work, give me another" always gets a new one.
 */
export const RESET_REPEAT_WINDOW_MS = 10_000;

export interface IssuedSetupCode {
  setupCode: string;
  issuedAt: Date;
  /** True when this call returned the code a reset moments earlier already issued, rather than replacing it. */
  reused: boolean;
}

async function userIdFor(tx: Tx, orgId: string, email: string): Promise<string | null> {
  const row = await tx.user.findUnique({ where: { orgId_email: { orgId, email: normalizeEmail(email) } }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * Admin-initiated "forgot password". There is no email-based reset — no mail
 * infrastructure is assumed to exist for every deployment of this app.
 *
 * ALWAYS ALLOWED: any member, any number of times, whatever state the account
 * is in — active, pending from an earlier reset, pending from creation, or a
 * legacy pending account whose code lives in passwordHash. A member who never
 * got the code, lost it, or was handed a dead one needs another, and nothing
 * here may stand in the way of that.
 *
 * Leaves exactly one credential — passwordHash null, setupCode set,
 * mustChangePassword true — and the database's User_single_credential_check
 * refuses any other shape. The previous code or password stops working the
 * moment this commits.
 *
 * Double submit: the member's row is locked FOR UPDATE first, so two concurrent
 * resets of one member run one after the other. The second then finds a code
 * this same admin issued inside RESET_REPEAT_WINDOW_MS and returns THAT code,
 * instead of generating one that would kill the code already on screen.
 */
export async function resetPassword(orgId: string, email: string, actor: string): Promise<IssuedSetupCode> {
  const e = normalizeEmail(email);
  const fresh = generateSetupCode();
  const sealed = sealSetupCode(fresh);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "orgId" = ${orgId} AND "email" = ${e} AND "deletedAt" IS NULL FOR UPDATE`;
    const id = locked[0]?.id;
    if (!id) throw new AppError("NOT_FOUND", "Member not found");

    const current = await tx.user.findUniqueOrThrow({
      where: { id },
      select: { setupCode: true, setupCodeIssuedAt: true, setupCodeIssuedById: true },
    });
    const actorId = await userIdFor(tx, orgId, actor);
    const now = new Date();

    const issuedAt = current.setupCodeIssuedAt;
    if (issuedAt && current.setupCodeIssuedById === actorId && now.getTime() - issuedAt.getTime() < RESET_REPEAT_WINDOW_MS) {
      const existing = openSetupCode(current.setupCode);
      if (existing) return { setupCode: existing, issuedAt, reused: true };
    }

    await tx.user.update({
      where: { id },
      data: { passwordHash: null, setupCode: sealed, setupCodeIssuedAt: now, setupCodeIssuedById: actorId, mustChangePassword: true },
    });
    await logAdminAction(tx, orgId, { actor, action: "reset_password", target: e });
    return { setupCode: fresh, issuedAt: now, reused: false };
  });
}

/**
 * "Resend code": the member's CURRENT setup code, shown again — never a new
 * one, so nothing the member may already have stops working. Null when there
 * is nothing to show: they already chose a password, or their pending code
 * predates the setupCode column (only a reset can issue a showable one).
 * Logged, since it puts a credential on screen.
 */
export async function revealSetupCode(
  orgId: string,
  email: string,
  actor: string,
): Promise<{ setupCode: string; issuedAt: Date | null } | null> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { orgId_email: { orgId, email: e }, ...LIVE },
    select: { setupCode: true, setupCodeIssuedAt: true },
  });
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  const setupCode = openSetupCode(user.setupCode);
  if (!setupCode) return null;
  await logAdminAction(prisma, orgId, { actor, action: "view_setup_code", target: e });
  return { setupCode, issuedAt: user.setupCodeIssuedAt };
}

export interface AccountAccess {
  state: AccountState;
  /** A pending code "Resend code" can show again. */
  codeRetrievable: boolean;
  /** The most recent reset or admin account creation, and who did it. Null when neither is on record. */
  lastIssued: { action: "reset_password" | "create_member"; at: Date | null; actor: string } | null;
  /** False when this email can't get past the sign-in domain gate — then no password or code will work for it. */
  loginAllowed: boolean;
}

/** Everything /admin/members/[id] needs to show, at a glance, whether a member is waiting on a code. */
export async function getAccountAccess(orgId: string, email: string): Promise<AccountAccess> {
  const e = normalizeEmail(email);
  const [auth, logRows, loginAllowed] = await Promise.all([
    getAuthRecord(orgId, e),
    prisma.adminLog.findMany({
      where: { orgId, target: e, action: { in: ["reset_password", "create_member"] } },
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
      take: 1,
    }),
    isLoginEmailAllowed(orgId, e),
  ]);
  const log = logRows.map(adminLogToDomain);
  const last = log[0];
  return {
    state: await getAccountState(e, auth, log),
    codeRetrievable: openSetupCode(auth?.setupCode) !== null,
    lastIssued: last ? { action: last.action as "reset_password" | "create_member", at: last.timestamp, actor: last.actor } : null,
    loginAllowed,
  };
}

// ---------------------------------------------------------------------------
// Join codes — the sole signup security boundary. See lib/joincodes.ts for
// the orchestration layer (rate limiting, generic-failure shaping); this
// module owns the actual comparisons and the atomic useCount increment.
// ---------------------------------------------------------------------------

export interface CreateJoinCodeInput {
  orgId: string;
  label: string;
  grantsRole: Role;
  expiresAt?: Date | null;
  maxUses?: number | null;
  createdBy: string;
}

export interface CreateJoinCodeResult {
  summary: JoinCodeSummary;
  /** Shown to the caller exactly once — never re-derivable after this (only the bcrypt hash is stored). */
  plaintext: string;
}

function hintFor(plaintext: string): string {
  return `${plaintext.slice(0, 2).toUpperCase()}••••`;
}

export async function createJoinCode(input: CreateJoinCodeInput): Promise<CreateJoinCodeResult> {
  const plaintext = generateSetupCode();
  const hash = await hashPassword(plaintext);
  return prisma.$transaction(async (tx) => {
    const creator = await tx.user.findUnique({
      where: { orgId_email: { orgId: input.orgId, email: normalizeEmail(input.createdBy) } },
      select: { id: true },
    });
    const row = await tx.joinCode.create({
      data: {
        orgId: input.orgId,
        code: hash,
        codeHint: hintFor(plaintext),
        grantsRole: roleToDb(input.grantsRole),
        label: input.label,
        expiresAt: input.expiresAt ?? null,
        maxUses: input.maxUses ?? null,
        createdById: creator?.id ?? null,
      },
    });
    await logAdminAction(tx, input.orgId, {
      actor: input.createdBy,
      action: "create_join_code",
      target: row.id,
      detail: `${input.label} (${input.grantsRole})`,
    });
    return { summary: joinCodeToSummary(row), plaintext };
  });
}

export async function listJoinCodes(orgId: string): Promise<JoinCodeSummary[]> {
  const rows = await prisma.joinCode.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
  return rows.map(joinCodeToSummary);
}

export async function deactivateJoinCode(orgId: string, id: string, actor: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.joinCode.findFirst({ where: { id, orgId } });
    if (!row) throw new AppError("NOT_FOUND", "Join code not found");
    await tx.joinCode.update({ where: { id }, data: { active: false } });
    await logAdminAction(tx, orgId, { actor, action: "deactivate_join_code", target: id, detail: row.label });
  });
}

export interface UpdateJoinCodeLimitsInput {
  orgId: string;
  id: string;
  expiresAt?: Date | null;
  maxUses?: number | null;
  actor: string;
}

export async function updateJoinCodeLimits(input: UpdateJoinCodeLimitsInput): Promise<JoinCodeSummary> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.joinCode.findFirst({ where: { id: input.id, orgId: input.orgId } });
    if (!existing) throw new AppError("NOT_FOUND", "Join code not found");
    const row = await tx.joinCode.update({
      where: { id: input.id },
      data: {
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      },
    });
    await logAdminAction(tx, input.orgId, { actor: input.actor, action: "update_join_code", target: input.id });
    return joinCodeToSummary(row);
  });
}

export interface RotateJoinCodeResult {
  summary: JoinCodeSummary;
  plaintext: string;
}

/** Deactivates the old code and creates a fresh one with the same label/role/limits — the old plaintext was never stored, so there's nothing to "change", only replace. */
export async function rotateJoinCodeById(
  orgId: string,
  id: string,
  actor: string,
  options: { requestToken?: string } = {},
): Promise<RotateJoinCodeResult> {
  const existing = await prisma.joinCode.findFirst({ where: { id, orgId } });
  if (!existing) throw new AppError("NOT_FOUND", "Join code not found");

  const plaintext = generateSetupCode();
  const hash = await hashPassword(plaintext);

  // The claim and the new code commit together, so two submissions of one
  // confirmation rotate the code once (see claimRequestToken above).
  try {
    return await prisma.$transaction(async (tx) => {
      if (options.requestToken) await claimRequestToken(tx, orgId, "rotate_join_code", options.requestToken, id);
      await tx.joinCode.update({ where: { id }, data: { active: false, rotatedAt: new Date() } });
      const creator = await tx.user.findUnique({
        where: { orgId_email: { orgId, email: normalizeEmail(actor) } },
        select: { id: true },
      });
      const row = await tx.joinCode.create({
        data: {
          orgId,
          code: hash,
          codeHint: hintFor(plaintext),
          grantsRole: existing.grantsRole,
          label: existing.label,
          expiresAt: existing.expiresAt,
          maxUses: existing.maxUses,
          createdById: creator?.id ?? null,
        },
      });
      await logAdminAction(tx, orgId, { actor, action: "rotate_join_code", target: row.id, detail: existing.label });
      return { summary: joinCodeToSummary(row), plaintext };
    });
  } catch (err) {
    if (isDuplicateRequest(err)) {
      throw new AppError(
        "DUPLICATE_REQUEST",
        "That rotation already happened — the code already on screen is the current one.",
      );
    }
    throw err;
  }
}

/** Internal shape used only by the matching/redemption functions below — never returned outside this module. */
interface JoinCodeCandidate {
  id: string;
  code: string;
  grantsRole: DbRole;
  label: string;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}

async function activeJoinCodeCandidates(tx: Tx | typeof prisma, orgId: string): Promise<JoinCodeCandidate[]> {
  return tx.joinCode.findMany({
    where: { orgId, active: true },
    select: { id: true, code: true, grantsRole: true, label: true, expiresAt: true, maxUses: true, useCount: true },
  });
}

/** A code is usable right now iff active (already filtered above), not expired, and under its use cap. */
function isRedeemable(candidate: JoinCodeCandidate, now: Date): boolean {
  if (candidate.expiresAt && candidate.expiresAt.getTime() < now.getTime()) return false;
  if (candidate.maxUses !== null && candidate.useCount >= candidate.maxUses) return false;
  return true;
}

/**
 * Constant-time-per-comparison bcrypt match against every active code for
 * this org (a handful of rows) — read-only, no mutation, so this is safe to
 * call from a "does this code work?" preview without spending a use. Returns
 * null on no match, an inactive code, an expired code, or an exhausted code —
 * deliberately the same null for all four (lib/joincodes.ts turns that into
 * one generic message; this function never tells the caller which case fired).
 */
export async function matchJoinCode(
  orgId: string,
  submittedCode: string,
  now: Date = new Date(),
): Promise<{ grantsRole: Role; label: string } | null> {
  const candidates = await activeJoinCodeCandidates(prisma, orgId);
  for (const candidate of candidates) {
    if (await verifyPassword(submittedCode, candidate.code)) {
      if (!isRedeemable(candidate, now)) return null;
      return { grantsRole: roleFromDb(candidate.grantsRole), label: candidate.label };
    }
  }
  return null;
}

export interface RedeemJoinCodeForSignupInput {
  orgId: string;
  submittedCode: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  profile?: ProfileFieldsInput;
  now?: Date;
}

export interface RedeemJoinCodeForSignupResult {
  member: Member;
  grantsRole: Role;
  label: string;
  /** True when an existing GUEST row (passwordHash null) was promoted in place rather than a fresh row created — the guest's prior registrations are untouched either way. */
  convertedFromGuest: boolean;
}

/**
 * The atomic half of signup (Part 3's "whole security model"): re-matches the
 * submitted code from scratch (never trusts a joinCodeId carried from an
 * earlier "preview" call — the code could have been deactivated in between),
 * atomically claims one use via a raw conditional UPDATE (ordinary
 * read-then-write inside a transaction is NOT enough here: Postgres's default
 * Read Committed isolation lets two concurrent redemptions both read
 * useCount < maxUses before either commits, which is exactly the
 * double-spend a `maxUses: 1` code exists to prevent), then creates the
 * account — or, if a GUEST row already exists for this email (someone who
 * checked into an event as a guest before ever signing up), promotes that row
 * in place instead of creating a duplicate, per Part 5's guest->member
 * conversion. Role is ALWAYS the matched code's grantsRole, never a
 * caller-supplied value — there is no role parameter on this function.
 *
 * A blank `submittedCode` is a legitimate input, not an error: general
 * membership needs no code at all, so an empty/whitespace code skips
 * matching entirely and creates a GENERAL account outright. This is also
 * what makes "claimed EBOARD/ADMIN but sent no code" downgrade to GENERAL
 * instead of failing — this function has no idea what the caller claimed,
 * it only ever looks at what code (if any) was actually submitted.
 */
export async function redeemJoinCodeForSignup(input: RedeemJoinCodeForSignupInput): Promise<RedeemJoinCodeForSignupResult> {
  const { orgId } = input;
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();
  const trimmedCode = input.submittedCode.trim();
  // Signup capturing classification/major counts as confirming them for this
  // season — same stamp registerForEvent/updateProfileFields apply, so the
  // check-in form doesn't immediately re-ask (see getMissingFields).
  const profile = input.profile;
  const stampProfileSeason = profile?.classification !== undefined || profile?.major !== undefined;
  const season = stampProfileSeason ? await getConfigValue(orgId, "SEASON", "") : null;

  return prisma.$transaction(async (tx) => {
    let grantsRole: Role;
    let matchedDbRole: DbRole;
    let label: string;

    if (!trimmedCode) {
      grantsRole = "general";
      matchedDbRole = DbRole.GENERAL;
      label = "No code entered";
    } else {
      const candidates = await activeJoinCodeCandidates(tx, orgId);
      let matched: JoinCodeCandidate | null = null;
      for (const candidate of candidates) {
        if (await verifyPassword(trimmedCode, candidate.code)) {
          matched = candidate;
          break;
        }
      }
      if (!matched || !isRedeemable(matched, now)) {
        throw new AppError("VALIDATION_FAILED", "That join code doesn't work. Check it and try again.", {
          fieldErrors: { joinCode: "That join code doesn't work. Check it and try again." },
        });
      }

      // Atomic claim: re-checks active/expiry/maxUses against the CURRENT row,
      // not the snapshot read above — 0 rows back means someone else (or the
      // clock) beat us to the last use since that read.
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "JoinCode"
        SET "useCount" = "useCount" + 1
        WHERE "id" = ${matched.id}
          AND "active" = true
          AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
          AND ("maxUses" IS NULL OR "useCount" < "maxUses")
        RETURNING "id"
      `;
      if (claimed.length === 0) {
        throw new AppError("VALIDATION_FAILED", "That join code doesn't work. Check it and try again.", {
          fieldErrors: { joinCode: "That join code doesn't work. Check it and try again." },
        });
      }

      grantsRole = roleFromDb(matched.grantsRole);
      matchedDbRole = matched.grantsRole;
      label = matched.label;
    }

    const profileData = input.profile
      ? {
          ...(input.profile.studentId !== undefined ? { studentId: input.profile.studentId } : {}),
          ...(input.profile.classification !== undefined
            ? { classification: classificationToDb(input.profile.classification) }
            : {}),
          ...(input.profile.major !== undefined ? { major: input.profile.major } : {}),
          ...(input.profile.majorOther !== undefined ? { majorOther: input.profile.majorOther } : {}),
          ...(input.profile.phone !== undefined ? { phone: input.profile.phone || null } : {}),
          ...(input.profile.personalEmail !== undefined ? { personalEmail: input.profile.personalEmail || null } : {}),
          ...(input.profile.tshirtSize !== undefined ? { tshirtSize: shirtSizeToDb(input.profile.tshirtSize) } : {}),
          ...(season !== null ? { profileSeason: season } : {}),
        }
      : {};

    // Deliberately unfiltered: a trashed row still owns this email (the
    // (orgId, email) unique covers it), so it can be neither converted nor
    // re-created. Refused with the same message as any existing account.
    const existingGuest = await tx.user.findUnique({ where: { orgId_email: { orgId, email } } });
    if (existingGuest?.deletedAt) {
      throw new AppError("VALIDATION_FAILED", "An account with this email already exists.", {
        fieldErrors: { email: "An account with this email already exists." },
      });
    }
    let row: UserModel;
    let convertedFromGuest = false;
    if (existingGuest && existingGuest.passwordHash === null) {
      convertedFromGuest = true;
      row = await tx.user.update({
        where: { id: existingGuest.id },
        data: {
          passwordHash: input.passwordHash,
          // A chosen password replaces any code an admin issued this row.
          setupCode: null,
          setupCodeIssuedAt: null,
          setupCodeIssuedById: null,
          mustChangePassword: false,
          firstName: input.firstName,
          lastName: input.lastName,
          role: matchedDbRole,
          status: DbUserStatus.ACTIVE,
          ...profileData,
        },
      });
    } else {
      try {
        row = await tx.user.create({
          data: {
            orgId,
            email,
            passwordHash: input.passwordHash,
            firstName: input.firstName,
            lastName: input.lastName,
            role: matchedDbRole,
            status: DbUserStatus.ACTIVE,
            ...profileData,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new AppError("VALIDATION_FAILED", "An account with this email already exists.", {
            fieldErrors: { email: "An account with this email already exists." },
          });
        }
        throw err;
      }
    }

    // The audit trail for a redeemed join code: who signed up, which account
    // row it created, and the role it granted. Nothing renders this — the
    // /admin "new admin/E-Board accounts" banner that used to read it back is
    // gone — but the record is the point, and it stays.
    await logAdminAction(tx, orgId, {
      actor: email,
      action: convertedFromGuest ? "join_code_guest_converted" : "join_code_signup",
      target: row.id,
      detail: `${label} -> ${grantsRole}`,
    });

    return { member: userToMember(row), grantsRole, label, convertedFromGuest };
  });
}

/**
 * /guest/join's redemption: matches ONLY among codes that grant GUEST — an
 * ADMIN/EBOARD/GENERAL code must fail here exactly like a wrong code, so an
 * outsider can never leverage a member code (or vice versa) to reach the
 * guest surface. Claims a use the same atomic way as signup, but creates no
 * User — a guest only gets a row once they actually check into an event (see
 * registerGuest).
 */
export async function redeemGuestJoinCode(orgId: string, submittedCode: string, now: Date = new Date()): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const candidates = await activeJoinCodeCandidates(tx, orgId);
    let matched: JoinCodeCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.grantsRole !== DbRole.GUEST) continue;
      if (await verifyPassword(submittedCode, candidate.code)) {
        matched = candidate;
        break;
      }
    }
    if (!matched || !isRedeemable(matched, now)) return null;

    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "JoinCode"
      SET "useCount" = "useCount" + 1
      WHERE "id" = ${matched.id}
        AND "active" = true
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
        AND ("maxUses" IS NULL OR "useCount" < "maxUses")
      RETURNING "id"
    `;
    if (claimed.length === 0) return null;

    await logAdminAction(tx, orgId, { actor: "guest", action: "guest_pass_issued", target: matched.id, detail: matched.label });
    return matched.label;
  });
}


// ---------------------------------------------------------------------------
// Form builder — schema-locked once any response exists for the event.
// ---------------------------------------------------------------------------

export interface FormFieldInput {
  fieldKey: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  helpText: string;
  order: number;
  prefill: string;
}

export interface SaveFormFieldsInput {
  orgId: string;
  eventId: string;
  fields: FormFieldInput[];
  actor: string;
}

/**
 * Replaces the full field list for an event's form. Once any response
 * exists, enforces the lock: a field can't be removed, its fieldKey can't
 * change, and its type can't change. New fields added after the lock must be
 * optional. This is the real boundary — the form builder UI disabling
 * controls is just a hint, not enforcement.
 */
export async function saveFormFields(input: SaveFormFieldsInput): Promise<FormField[]> {
  if (input.fields.length > MAX_EXTRA_QUESTIONS_HARD_CAP) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Events can have at most ${MAX_EXTRA_QUESTIONS_HARD_CAP} extra questions — the core check-in form already covers the rest.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findFirst({ where: { id: input.eventId, orgId: input.orgId, ...LIVE } });
    if (!event) throw new AppError("NOT_FOUND", "Event not found");

    const existing = (await tx.formField.findMany({ where: { eventId: input.eventId } })).map(formFieldToDomain);
    const locked = (await tx.registration.findFirst({ where: { eventId: input.eventId }, select: { id: true } })) !== null;

    if (locked) {
      const existingByKey = new Map(existing.map((f) => [f.fieldKey, f]));
      const newByKey = new Map(input.fields.map((f) => [f.fieldKey, f]));
      for (const [key, oldField] of existingByKey) {
        const stillPresent = newByKey.get(key);
        if (!stillPresent) {
          throw new AppError(
            "SCHEMA_LOCKED",
            `Can't remove "${oldField.label}" — responses already exist for this event.`,
          );
        }
        if (stillPresent.type !== oldField.type) {
          throw new AppError(
            "SCHEMA_LOCKED",
            `Can't change the type of "${oldField.label}" — responses already exist for this event.`,
          );
        }
      }
      for (const [key, newField] of newByKey) {
        if (!existingByKey.has(key) && newField.required) {
          throw new AppError(
            "SCHEMA_LOCKED",
            `New field "${newField.label}" must be optional — responses already exist for this event.`,
          );
        }
      }
    }

    await tx.formField.deleteMany({ where: { eventId: input.eventId } });
    if (input.fields.length > 0) {
      await tx.formField.createMany({
        data: input.fields.map((field) => ({
          eventId: input.eventId,
          fieldKey: field.fieldKey,
          label: field.label,
          type: FIELD_TYPE_TO_DB[field.type],
          required: field.required,
          options: field.options,
          helpText: field.helpText || null,
          order: field.order,
          prefill: field.prefill || null,
        })),
      });
    }
    await logAdminAction(tx, input.orgId, { actor: input.actor, action: "update_form", target: input.eventId });

    return (await tx.formField.findMany({ where: { eventId: input.eventId }, orderBy: { order: "asc" } })).map(
      formFieldToDomain,
    );
  });
}

/** Copies another event's questions onto this one — for a brand-new event with no fields of its own yet. */
export async function copyFormFields(orgId: string, fromEventId: string, toEventId: string, actor: string): Promise<FormField[]> {
  return prisma.$transaction(async (tx) => {
    const toEvent = await tx.event.findFirst({ where: { id: toEventId, orgId, ...LIVE } });
    if (!toEvent) throw new AppError("NOT_FOUND", "Event not found");
    const fromEvent = await tx.event.findFirst({ where: { id: fromEventId, orgId, ...LIVE } });
    if (!fromEvent) throw new AppError("NOT_FOUND", "Source event not found");

    const sourceFields = (
      await tx.formField.findMany({ where: { eventId: fromEventId }, orderBy: { order: "asc" } })
    ).map(formFieldToDomain);

    await tx.formField.deleteMany({ where: { eventId: toEventId } });
    if (sourceFields.length > 0) {
      await tx.formField.createMany({
        data: sourceFields.map((field) => ({
          eventId: toEventId,
          fieldKey: field.fieldKey,
          label: field.label,
          type: FIELD_TYPE_TO_DB[field.type],
          required: field.required,
          options: field.options,
          helpText: field.helpText || null,
          order: field.order,
          prefill: field.prefill || null,
        })),
      });
    }
    await logAdminAction(tx, orgId, {
      actor,
      action: "copy_form",
      target: toEventId,
      detail: `Copied from ${fromEventId}`,
    });

    return (await tx.formField.findMany({ where: { eventId: toEventId }, orderBy: { order: "asc" } })).map(
      formFieldToDomain,
    );
  });
}

// ---------------------------------------------------------------------------
// Bulk member import
// ---------------------------------------------------------------------------

export interface BulkImportRow {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
}

export interface BulkImportSkip {
  row: BulkImportRow;
  reason: string;
}

export interface BulkImportPreview {
  toCreate: BulkImportRow[];
  toSkip: BulkImportSkip[];
}

/** Read-only dry run: what would be created vs skipped, without writing anything. */
export async function previewBulkImport(orgId: string, rows: BulkImportRow[]): Promise<BulkImportPreview> {
  const emails = rows.map((r) => normalizeEmail(r.email)).filter(Boolean);
  // Deliberately unfiltered: a trashed account still owns its email, so the
  // import can't create it — say where it is instead of "already on the
  // roster", which the admin can't see it on.
  const existingUsers = await prisma.user.findMany({
    where: { orgId, email: { in: emails } },
    select: { email: true, deletedAt: true },
  });
  const existing = new Set(existingUsers.map((u) => u.email));
  const trashed = new Set(existingUsers.filter((u) => u.deletedAt !== null).map((u) => u.email));
  const seen = new Set<string>();
  const toCreate: BulkImportRow[] = [];
  const toSkip: BulkImportSkip[] = [];

  for (const raw of rows) {
    const email = normalizeEmail(raw.email);
    const row = { ...raw, email };
    if (!email || !raw.firstName.trim() || !raw.lastName.trim()) {
      toSkip.push({ row, reason: "Missing email, first name, or last name" });
      continue;
    }
    if (trashed.has(email)) {
      toSkip.push({ row, reason: "In the trash — restore it from /admin/trash instead" });
      continue;
    }
    if (existing.has(email)) {
      toSkip.push({ row, reason: "Already on the roster" });
      continue;
    }
    if (seen.has(email)) {
      toSkip.push({ row, reason: "Duplicate row in this file" });
      continue;
    }
    seen.add(email);
    toCreate.push(row);
  }
  return { toCreate, toSkip };
}

export interface BulkImportCommitResult {
  created: Array<{ email: string; setupCode: string }>;
  skipped: number;
}

/**
 * Each row is its own independent create — a duplicate (P2002) just skips
 * that row rather than aborting the whole batch, and re-validates against
 * live data (not the preview) so a concurrent add between preview and commit
 * can't create a duplicate row.
 */
export async function commitBulkImport(orgId: string, rows: BulkImportRow[], actor: string): Promise<BulkImportCommitResult> {
  const seen = new Set<string>();
  const created: Array<{ email: string; setupCode: string }> = [];
  const actorId = await userIdFor(prisma, orgId, actor);

  for (const raw of rows) {
    const email = normalizeEmail(raw.email);
    if (!email || !raw.firstName.trim() || !raw.lastName.trim()) continue;
    if (seen.has(email)) continue;
    seen.add(email);

    // Same pending shape as createMemberAccount.
    const setupCode = generateSetupCode();
    try {
      await prisma.user.create({
        data: {
          orgId,
          email,
          passwordHash: null,
          setupCode: sealSetupCode(setupCode),
          setupCodeIssuedAt: new Date(),
          setupCodeIssuedById: actorId,
          firstName: raw.firstName.trim(),
          lastName: raw.lastName.trim(),
          role: roleToDb(raw.role),
          status: DbUserStatus.ACTIVE,
          mustChangePassword: true,
        },
      });
      created.push({ email, setupCode });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }

  await prisma.$transaction(async (tx) => {
    await logAdminAction(tx, orgId, {
      actor,
      action: "bulk_import_members",
      target: "members",
      detail: `${created.length} created, ${rows.length - created.length} skipped`,
    });
  });

  return { created, skipped: rows.length - created.length };
}

// ---------------------------------------------------------------------------
// Attendance directory (/admin/attendance) — the event-centric view.
//
// The old page loaded every registration in the org and rendered one flat
// list. These functions replace that with two scoped reads: a summary row per
// event for the list, and one page of attendees for the ONE event actually
// open. Nothing here ever loads every registration in the season.
// ---------------------------------------------------------------------------

export interface EventAttendanceSummary {
  eventId: string;
  name: string;
  date: Date | null;
  closesAt: Date | null;
  status: EventStatus;
  categoryName: string;
  categoryShortName: string;
  audience: Audience;
  groupId: string | null;
  /**
   * The event's headcount. Includes a trashed member's registration on
   * purpose: trashing hides the person, it doesn't un-happen their attendance,
   * so the count an officer reported for the event stays true.
   */
  attendeeCount: number;
  /** Sum of Registration.pointsAwarded — the historical snapshot, which is what an officer auditing an event expects to see. */
  totalPoints: number;
  manualCount: number;
}

/**
 * One row per event for the directory list, newest first. Two queries total
 * (events, then a grouped aggregate over their registrations) regardless of
 * how many events the season holds — never one count per event.
 */
export async function getEventAttendanceSummaries(orgId: string): Promise<EventAttendanceSummary[]> {
  const events = await prisma.event.findMany({
    where: { orgId, ...LIVE },
    include: EVENT_INCLUDE,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  if (events.length === 0) return [];

  const eventIds = events.map((e) => e.id);
  const [totals, manual] = await Promise.all([
    prisma.registration.groupBy({
      by: ["eventId"],
      where: { eventId: { in: eventIds } },
      _count: { _all: true },
      _sum: { pointsAwarded: true },
    }),
    prisma.registration.groupBy({
      by: ["eventId"],
      where: { eventId: { in: eventIds }, source: DbSource.MANUAL },
      _count: { _all: true },
    }),
  ]);

  const totalBy = new Map(totals.map((t) => [t.eventId, t]));
  const manualBy = new Map(manual.map((m) => [m.eventId, m._count._all]));

  return events.map((row) => {
    const event = eventToDomain(row);
    const agg = totalBy.get(event.eventId);
    return {
      eventId: event.eventId,
      name: event.name,
      date: event.date,
      closesAt: event.closesAt,
      status: event.status,
      categoryName: event.category.name,
      categoryShortName: event.category.shortName,
      audience: event.audience,
      groupId: event.groupId,
      attendeeCount: agg?._count._all ?? 0,
      totalPoints: agg?._sum.pointsAwarded ?? 0,
      manualCount: manualBy.get(event.eventId) ?? 0,
    };
  });
}

export interface AttendeeRow {
  registrationId: string;
  email: string;
  firstName: string;
  lastName: string;
  classification: Classification | "";
  house: string;
  checkedInAt: Date | null;
  pointsAwarded: number;
  source: string;
  note: string;
}

export interface AttendeePage {
  rows: AttendeeRow[];
  /** Opaque cursor for the next page, or null when this was the last one. */
  nextCursor: string | null;
  /** Every attendee matching the search, not just this page — see the note on getMembersPage. Live members only. */
  total: number;
  totalPoints: number;
  /** Registrations on this event belonging to trashed members: still in the event's headcount (see EventAttendanceSummary), never listed. */
  trashedCount: number;
}

/**
 * One page of an event's attendees, ordered by check-in time (the default the
 * directory renders). Cursor-paginated on (createdAt, id): createdAt alone is
 * not unique — two people checking in during the same second would make rows
 * skip or repeat across pages — so id breaks the tie and makes the sort
 * total.
 */
export async function getEventAttendees(
  orgId: string,
  eventId: string,
  options: { q?: string; cursor?: string | null; limit?: number } = {},
): Promise<AttendeePage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const q = (options.q ?? "").trim();

  const where: Prisma.RegistrationWhereInput = {
    eventId,
    event: { orgId, ...LIVE },
    user: {
      ...LIVE,
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" as const } },
              { lastName: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
              { studentId: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
  };

  const [aggregate, rows, trashedCount] = await Promise.all([
    prisma.registration.aggregate({ where, _count: { _all: true }, _sum: { pointsAwarded: true } }),
    prisma.registration.findMany({
      where,
      include: { user: { select: { email: true, firstName: true, lastName: true, classification: true, house: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    }),
    prisma.registration.count({ where: { eventId, event: { orgId, ...LIVE }, user: { deletedAt: { not: null } } } }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    trashedCount,
    rows: page.map((r) => ({
      registrationId: r.id,
      email: r.user.email,
      firstName: r.user.firstName,
      lastName: r.user.lastName,
      classification: classificationFromDb(r.user.classification),
      house: r.user.house ?? "",
      checkedInAt: r.createdAt,
      pointsAwarded: r.pointsAwarded,
      source: r.source === DbSource.MANUAL ? "manual" : "form",
      note: r.note ?? "",
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    total: aggregate._count._all,
    totalPoints: aggregate._sum.pointsAwarded ?? 0,
  };
}

export interface AddableMember {
  email: string;
  firstName: string;
  lastName: string;
  studentId: string;
  role: Role;
}

/**
 * Members who could still be added to this event — everyone on the roster
 * MINUS whoever is already registered. Excluding them in the query (rather
 * than letting the picker offer them and the write reject them) is what makes
 * the (eventId, userId) unique constraint a backstop instead of the primary
 * mechanism; the constraint still fires if two admins pick the same person at
 * once (see addManualAttendanceBulk).
 */
export async function getAddableMembers(
  orgId: string,
  eventId: string,
  options: { q?: string; limit?: number } = {},
): Promise<AddableMember[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const q = (options.q ?? "").trim();

  const rows = await prisma.user.findMany({
    where: {
      orgId,
      ...LIVE,
      // GUEST accounts can never sign in and are not part of the roster an
      // officer adds attendance for (see lib/joincodes.ts registerGuest).
      role: { not: DbRole.GUEST },
      registrations: { none: { eventId } },
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" as const } },
              { lastName: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
              { studentId: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: { email: true, firstName: true, lastName: true, studentId: true, role: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: limit,
  });

  return rows.map((u) => ({
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    studentId: u.studentId ?? "",
    role: roleFromDb(u.role),
  }));
}

export interface ManualAddPreviewMember {
  email: string;
  name: string;
  role: Role;
  /** What this member will receive, computed by the SAME lib/points.ts memberPointsFor call a real check-in makes — see registerForEvent. */
  points: number;
  /** True when the role earns nothing on the member track (E-Board/Admin earn on the internal track instead — see memberPointsFor). */
  zeroByRole: boolean;
  /** Set when this event belongs to an EventGroup and adding them changes their NSBE Week bonus. */
  groupBonusChange: { groupName: string; from: number; to: number } | null;
}

export interface ManualAddPreview {
  eventName: string;
  /** True once closesAt has passed — the normal case for a manual add, and worth saying out loud in the confirmation. */
  eventClosed: boolean;
  members: ManualAddPreviewMember[];
  totalPoints: number;
  /** The calendar month this event's attendance lands in ("2026-09"), or null when the event has no close time to bucket by. */
  monthlyChampionMonth: string | null;
  /** True when that month is still open, so a manual add can still change who wins it. */
  monthlyChampionStillOpen: boolean;
}

/**
 * What adding these members would do, computed before anything is written.
 *
 * Three things an officer cannot see from the picker alone, and all three can
 * change the leaderboard:
 *   - the points each member receives (0 for an officer, by role)
 *   - an NSBE Week bonus crossing a tier because this event completes a set
 *   - a still-open month whose Engagement Champion this could decide
 */
export async function previewManualAttendance(
  orgId: string,
  eventId: string,
  emails: string[],
  now: Date = new Date(),
): Promise<ManualAddPreview> {
  const normalized = [...new Set(emails.map((e) => normalizeEmail(e)))].filter(Boolean);

  const eventRow = await prisma.event.findFirst({ where: { id: eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
  if (!eventRow) throw new AppError("NOT_FOUND", "Event not found");
  const event = eventToDomain(eventRow);

  const users = await prisma.user.findMany({
    where: { orgId, email: { in: normalized }, ...LIVE },
    select: { id: true, email: true, firstName: true, lastName: true, role: true },
  });

  // The group this event belongs to, if any — needed to say whether the add
  // moves anyone across a bonus tier.
  const group = event.groupId ? await getEventGroup(orgId, event.groupId) : null;
  const groupEvents = group
    ? await prisma.event.findMany({ where: { orgId, groupId: event.groupId, ...LIVE }, include: EVENT_INCLUDE })
    : [];
  const groupInput = group
    ? {
        events: groupEvents.map((e) => {
          const d = eventToDomain(e);
          return { eventId: d.eventId, status: d.status, closesAt: d.closesAt };
        }),
        bonusTiers: group.bonusTiers,
        finalizedAt: group.finalizedAt,
      }
    : null;

  // Every existing registration for these members inside the group — one
  // query, not one per member.
  const groupRegistrations = groupInput
    ? await prisma.registration.findMany({
        where: { userId: { in: users.map((u) => u.id) }, event: { orgId, groupId: event.groupId, ...LIVE } },
        select: { userId: true, eventId: true },
      })
    : [];

  const members: ManualAddPreviewMember[] = users.map((u) => {
    const role = roleFromDb(u.role);
    const points = memberPointsFor({ role }, event, event.category);

    let groupBonusChange: ManualAddPreviewMember["groupBonusChange"] = null;
    if (groupInput && group) {
      const mine = groupRegistrations.filter((r) => r.userId === u.id).map((r) => ({ eventId: r.eventId }));
      const from = groupBonusFor(mine, groupInput, now);
      const to = groupBonusFor([...mine, { eventId: event.eventId }], groupInput, now);
      if (from !== to) groupBonusChange = { groupName: group.name, from, to };
    }

    return {
      email: u.email,
      name: memberDisplayName(u.firstName, u.lastName, u.email),
      role,
      points,
      zeroByRole: role !== "general",
      groupBonusChange,
    };
  });

  const month = event.closesAt
    ? `${event.closesAt.getFullYear()}-${String(event.closesAt.getMonth() + 1).padStart(2, "0")}`
    : null;

  return {
    eventName: event.name,
    eventClosed: event.closesAt !== null && event.closesAt.getTime() <= now.getTime(),
    members,
    totalPoints: members.reduce((sum, m) => sum + m.points, 0),
    monthlyChampionMonth: month,
    // A manual add still counts toward the Monthly Engagement Champion, so
    // while the month is open this can change who wins it.
    monthlyChampionStillOpen: month !== null && !isMonthOver(month, now),
  };
}

export interface BulkManualAddResult {
  added: string[];
  /** Already registered — rejected by the (eventId, userId) unique constraint, never duplicated. */
  alreadyRegistered: string[];
  notFound: string[];
  totalPoints: number;
}

/**
 * Adds several members to one event in a single pass — the after-a-meeting
 * case the directory exists for.
 *
 * Each member gets their own Registration (source MANUAL, note attached) and
 * their own AdminLog row, so the audit trail names every person added and the
 * reason. Standings are invalidated once at the end rather than per member.
 *
 * A member already registered is REPORTED, not duplicated and not fatal: an
 * officer adding eight people after a meeting shouldn't lose the other seven
 * because one of them had already checked in.
 */
export async function addManualAttendanceBulk(input: {
  orgId: string;
  eventId: string;
  emails: string[];
  note: string;
  addedBy: string;
  now?: Date;
}): Promise<BulkManualAddResult> {
  const { orgId, eventId } = input;
  const note = input.note.trim();
  if (!note) throw new AppError("VALIDATION_FAILED", "A note is required — say why this member is being added.");

  const emails = [...new Set(input.emails.map((e) => normalizeEmail(e)))].filter(Boolean);
  if (emails.length === 0) throw new AppError("VALIDATION_FAILED", "Select at least one member.");

  const now = input.now ?? new Date();
  const eventRow = await prisma.event.findFirst({ where: { id: eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
  if (!eventRow) throw new AppError("NOT_FOUND", "Event not found");
  const event = eventToDomain(eventRow);

  const users = await prisma.user.findMany({ where: { orgId, email: { in: emails }, ...LIVE } });
  const byEmail = new Map(users.map((u) => [u.email, u]));

  const result: BulkManualAddResult = { added: [], alreadyRegistered: [], notFound: [], totalPoints: 0 };

  for (const email of emails) {
    const user = byEmail.get(email);
    if (!user) {
      result.notFound.push(email);
      continue;
    }
    const role = roleFromDb(user.role);
    const pointsAwarded = memberPointsFor({ role }, event, event.category);

    try {
      await prisma.$transaction(async (tx) => {
        await tx.registration.create({
          data: {
            eventId: event.eventId,
            userId: user.id,
            pointsAwarded,
            roleAtTime: roleToDb(role),
            source: DbSource.MANUAL,
            note,
            createdAt: now,
          },
        });
        await logAdminAction(tx, orgId, {
          actor: input.addedBy,
          action: "add_attendance",
          target: `${event.eventId}:${email}`,
          detail: note,
        });
      });
      result.added.push(email);
      result.totalPoints += pointsAwarded;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        result.alreadyRegistered.push(email);
        continue;
      }
      throw err;
    }
  }

  if (result.added.length > 0) {
    invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
    await onHouseAttendanceChanged(orgId, event.eventId);
  }
  return result;
}

export interface RemoveRegistrationImpact {
  email: string;
  name: string;
  eventName: string;
  /** The points this registration contributed, which the member loses. */
  pointsLost: number;
  /** Set when the event is in an EventGroup and removing it drops them a bonus tier. */
  groupBonusChange: { groupName: string; from: number; to: number } | null;
}

/** What removing this registration would cost the member — shown in the confirmation BEFORE it happens, because removal changes a leaderboard total. */
export async function previewRemoveRegistration(
  orgId: string,
  registrationId: string,
  now: Date = new Date(),
): Promise<RemoveRegistrationImpact> {
  const row = await prisma.registration.findFirst({
    where: { id: registrationId, ...liveRegistrationWhere(orgId) },
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
      event: { include: EVENT_INCLUDE },
    },
  });
  if (!row) throw new AppError("NOT_FOUND", "Attendance record not found");
  const event = eventToDomain(row.event);

  let groupBonusChange: RemoveRegistrationImpact["groupBonusChange"] = null;
  if (event.groupId) {
    const group = await getEventGroup(orgId, event.groupId);
    if (group) {
      const groupEvents = await prisma.event.findMany({
        where: { orgId, groupId: event.groupId, ...LIVE },
        include: EVENT_INCLUDE,
      });
      const groupInput = {
        events: groupEvents.map((e) => {
          const d = eventToDomain(e);
          return { eventId: d.eventId, status: d.status, closesAt: d.closesAt };
        }),
        bonusTiers: group.bonusTiers,
        finalizedAt: group.finalizedAt,
      };
      const mine = await prisma.registration.findMany({
        where: { userId: row.user.id, event: { orgId, groupId: event.groupId, ...LIVE } },
        select: { eventId: true },
      });
      const from = groupBonusFor(mine, groupInput, now);
      const to = groupBonusFor(
        mine.filter((r) => r.eventId !== event.eventId),
        groupInput,
        now,
      );
      if (from !== to) groupBonusChange = { groupName: group.name, from, to };
    }
  }

  return {
    email: row.user.email,
    name: memberDisplayName(row.user.firstName, row.user.lastName, row.user.email),
    eventName: event.name,
    pointsLost: row.pointsAwarded,
    groupBonusChange,
  };
}

/** Removal with a required reason — the reason lands in AdminLog, because this silently lowers someone's standing. */
export async function removeRegistration(
  orgId: string,
  registrationId: string,
  reason: string,
  actor: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "A reason is required to remove a registration.");

  const eventId = await prisma.$transaction(async (tx) => {
    const row = await tx.registration.findFirst({
      where: { id: registrationId, ...liveRegistrationWhere(orgId) },
      include: { user: { select: { email: true } } },
    });
    if (!row) throw new AppError("NOT_FOUND", "Attendance record not found");
    await tx.registration.delete({ where: { id: registrationId } });
    await logAdminAction(tx, orgId, {
      actor,
      action: "delete_attendance",
      target: `${row.eventId}:${row.user.email}`,
      detail: `${row.pointsAwarded} pts removed — ${trimmed}`,
    });
    return row.eventId;
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  await onHouseAttendanceChanged(orgId, eventId);
}

/** Point correction on one registration, reason required and logged with the before/after values. */
export async function updateRegistrationPoints(
  orgId: string,
  registrationId: string,
  points: number,
  reason: string,
  actor: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "A reason is required to change points.");
  if (!Number.isInteger(points) || points < 0) {
    throw new AppError("VALIDATION_FAILED", "Points must be a whole number, zero or more.");
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.registration.findFirst({
      where: { id: registrationId, ...liveRegistrationWhere(orgId) },
      include: { user: { select: { email: true } } },
    });
    if (!row) throw new AppError("NOT_FOUND", "Attendance record not found");
    await tx.registration.update({ where: { id: registrationId }, data: { pointsAwarded: points } });
    await logAdminAction(tx, orgId, {
      actor,
      action: "update_attendance_points",
      target: `${row.eventId}:${row.user.email}`,
      detail: `${row.pointsAwarded} → ${points} — ${trimmed}`,
    });
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

// ---------------------------------------------------------------------------
// Paginated roster (/admin/members).
//
// getMembersWithStats above loads every member, every registration, every auth
// record and the whole AdminLog to render one page. That is fine at 40 members
// and unusable at 200+, so the roster uses the three functions below instead:
// filtered COUNT queries for the summaries, and a filtered, cursor-paginated
// page of rows whose derived fields are computed for THAT PAGE only.
//
// The filters live in SQL rather than in a .filter() over a preloaded array
// precisely so they describe the whole roster: searching for a name has to
// find someone who isn't on the loaded page, and the summary counts have to
// cover all 213 matching members, not the 20 on screen.
// ---------------------------------------------------------------------------

export type MemberTriFilter = "all" | "yes" | "no";
export type MemberHouseFilter = "all" | "verified" | "pending" | "missing";

export interface MemberFilters {
  q?: string;
  role?: Role | "all";
  status?: UserStatus | "all";
  classification?: Classification | "all";
  major?: string;
  eligible?: MemberTriFilter;
  dues?: MemberTriFilter;
  national?: MemberTriFilter;
  house?: MemberHouseFilter;
  resume?: MemberTriFilter;
  /** A specific size, "none" for members who have never given one, or "all". */
  tshirt?: string;
}

/** yes -> the condition; no -> its negation; all -> nothing at all. */
function tri(filter: MemberTriFilter | undefined, yes: Prisma.UserWhereInput): Prisma.UserWhereInput[] {
  if (filter === "yes") return [yes];
  if (filter === "no") return [{ NOT: yes }];
  return [];
}

/**
 * The ONE translation of the roster's filter bar into SQL. Both the page query
 * and the aggregate queries build from this, so a member counted in the
 * summary is exactly a member who would appear in the list.
 *
 * `currentSeason` is needed because eligibility is not a column — it is
 * lib/points.ts isEligible's three conditions, which are all columns, so the
 * filter can live in the query rather than forcing every member to be loaded
 * and tested in memory.
 */
function memberWhere(orgId: string, filters: MemberFilters, currentSeason: string): Prisma.UserWhereInput {
  const q = (filters.q ?? "").trim();
  const and: Prisma.UserWhereInput[] = [];

  if (filters.role && filters.role !== "all") and.push({ role: roleToDb(filters.role) });
  if (filters.status && filters.status !== "all") and.push({ status: statusToDb(filters.status) });
  if (filters.classification && filters.classification !== "all") {
    and.push({ classification: classificationToDb(filters.classification) });
  }
  if (filters.major && filters.major !== "all") and.push({ major: filters.major });

  // isEligible's exact conditions. An unset Config.SEASON matches nobody,
  // mirroring the Boolean(currentSeason) guard in lib/points.ts rather than
  // letting "" match a member who has never reported anything.
  const eligibleWhere: Prisma.UserWhereInput = currentSeason
    ? { duesPaidReported: true, nationalMemberReported: true, membershipSeason: currentSeason }
    : { id: { in: [] } };
  and.push(...tri(filters.eligible, eligibleWhere));

  // Dues/National filter on the CLAIM, not on verification — unchanged from
  // the old in-memory filter.
  and.push(...tri(filters.dues, { duesPaidReported: true }));
  and.push(...tri(filters.national, { nationalMemberReported: true }));
  and.push(...tri(filters.resume, { resumeFileId: { not: null } }));

  if (filters.house === "verified") and.push({ houseVerifiedAt: { not: null } });
  else if (filters.house === "pending") and.push({ houseVerifiedAt: null, house: { not: null } });
  else if (filters.house === "missing") and.push({ houseVerifiedAt: null, OR: [{ house: null }, { house: "" }] });

  if (filters.tshirt === "none") and.push({ tshirtSize: null });
  else if (filters.tshirt && filters.tshirt !== "all") {
    and.push({ tshirtSize: shirtSizeToDb(filters.tshirt as ShirtSize) });
  }

  if (q) {
    and.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { studentId: { contains: q, mode: "insensitive" } },
        { nsbeMembershipId: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  return { orgId, ...LIVE, AND: and };
}

export interface MemberAggregates {
  /** Every member matching the filters — the "of 213" in "Showing 20 of 213". */
  total: number;
  eligible: number;
}

/**
 * The summary numbers, computed over the WHOLE filtered set with aggregate
 * queries — never from the rows on screen. A count built from one loaded page
 * looks authoritative and is wrong, so this deliberately cannot see the page.
 */
export async function getMemberAggregates(orgId: string, filters: MemberFilters): Promise<MemberAggregates> {
  const currentSeason = await getConfigValue(orgId, "SEASON", "");
  const where = memberWhere(orgId, filters, currentSeason);

  const [total, eligible] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.count({
      where: currentSeason
        ? { AND: [where, { duesPaidReported: true, nationalMemberReported: true, membershipSeason: currentSeason }] }
        : { AND: [where, { id: { in: [] } }] },
    }),
  ]);

  return { total, eligible };
}

export interface MembersPage {
  rows: MemberWithStats[];
  /** Opaque cursor for the next page, or null when this page was the last. */
  nextCursor: string | null;
}

/**
 * One page of the filtered roster.
 *
 * Ordered by (lastName, firstName, id). The id is not decoration: lastName and
 * firstName are not unique, and a cursor over a non-total ordering silently
 * skips or repeats rows when two members share a name. Ending the sort on a
 * unique column makes the order total, which is what makes the cursor stable
 * even if someone is added to the roster mid-session.
 *
 * Every derived field (points, events, account state, last active) is computed
 * for the members ON THIS PAGE only — the whole point of the rewrite is that
 * nothing here scales with the size of the roster.
 */
export async function getMembersPage(
  orgId: string,
  filters: MemberFilters,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<MembersPage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const currentSeason = await getConfigValue(orgId, "SEASON", "");
  const where = memberWhere(orgId, filters, currentSeason);

  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const members = pageRows.map(userToMember);
  const emails = members.map((m) => m.email);

  if (members.length === 0) return { rows: [], nextCursor: null };

  // Scoped to this page's members, never the whole org. Registrations for a
  // trashed event are excluded — that's the Events column dropping when an
  // event is trashed, and coming back exactly when it's restored.
  const [registrations, authRows, logRows, trueTotals] = await Promise.all([
    prisma.registration.findMany({
      where: { event: { orgId, ...LIVE }, user: { orgId, email: { in: emails } } },
      select: { createdAt: true, user: { select: { email: true } } },
    }),
    prisma.user.findMany({
      where: { orgId, email: { in: emails } },
      select: { email: true, passwordHash: true, setupCode: true, role: true, mustChangePassword: true, status: true },
    }),
    prisma.adminLog.findMany({
      where: { orgId, target: { in: emails } },
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    }),
    trueTotalsFor(orgId, members, currentSeason),
  ]);

  const totalsByEmail = new Map<string, { events: number }>();
  const lastAttendanceByEmail = new Map<string, Date>();
  for (const r of registrations) {
    const email = r.user.email;
    const entry = totalsByEmail.get(email) ?? { events: 0 };
    entry.events += 1;
    totalsByEmail.set(email, entry);
    if (r.createdAt) {
      const existing = lastAttendanceByEmail.get(email);
      if (!existing || r.createdAt > existing) lastAttendanceByEmail.set(email, r.createdAt);
    }
  }

  const log = logRows.map(adminLogToDomain);
  const lastLogByEmail = new Map<string, Date>();
  for (const entry of log) {
    const key = normalizeEmail(entry.target);
    if (!lastLogByEmail.has(key) && entry.timestamp) lastLogByEmail.set(key, entry.timestamp);
  }
  const authByEmail = new Map(authRows.map((a) => [a.email, userToAuthRecord(a as never)]));
  const nameById = new Map(members.map((m) => [m.id, memberDisplayName(m.firstName, m.lastName, m.email)]));

  const withStats = await Promise.all(
    members.map(async (m) => {
      const totals = totalsByEmail.get(m.email);
      const accountState = await getAccountState(m.email, authByEmail.get(m.email) ?? null, log);
      const houseState: MemberWithStats["houseState"] = m.houseVerifiedAt ? "verified" : m.house ? "pending" : "none";
      const lastAttended = lastAttendanceByEmail.get(m.email) ?? null;
      const lastLogged = lastLogByEmail.get(normalizeEmail(m.email)) ?? null;
      const lastActiveAt =
        lastAttended && lastLogged ? (lastAttended > lastLogged ? lastAttended : lastLogged) : lastAttended ?? lastLogged;

      return {
        ...m,
        points: trueTotals.get(m.email)?.total ?? 0,
        events: totals?.events ?? 0,
        accountState,
        eligible: isEligible(m, currentSeason),
        duesState: claimState(m.duesPaidReported, m.duesVerifiedAt, m.duesRevokedAt),
        nationalState: claimState(m.nationalMemberReported, m.nationalVerifiedAt, m.nationalRevokedAt),
        duesVerifiedByName: nameById.get(m.duesVerifiedById) ?? "",
        nationalVerifiedByName: nameById.get(m.nationalVerifiedById) ?? "",
        houseState,
        lastActiveAt,
      } satisfies MemberWithStats;
    }),
  );

  return { rows: withStats, nextCursor: hasMore ? pageRows[pageRows.length - 1].id : null };
}

// ---------------------------------------------------------------------------
// Point adjustments.
//
// Never an edit to Registration.pointsAwarded: a Registration is the
// attendance record, and rewriting it destroys the reason the points existed.
// An adjustment is its own PointAward row (kind ADJUSTMENT) — signed, reasoned,
// stamped with the season it was made in, and revocable exactly like any other
// award. Totals stay derived: memberTotal sums it into `adjustments`.
//
// Gated on the points_write permission (lib/access.ts), held outright by ADMIN
// only — deliberately not attendance_write. Every create and revoke writes an
// AdminLog row in the same transaction and invalidates the standings cache.
// ---------------------------------------------------------------------------

/** "correction" is not a reason. */
export const ADJUSTMENT_REASON_MIN_LENGTH = 10;
/** A fat-finger ceiling, not a policy: nothing in this chapter's scoring moves a member by hundreds of points. */
export const ADJUSTMENT_MAX_ABS = 500;

function validateAdjustment(points: number, reason: string): string {
  if (!Number.isInteger(points) || points === 0) {
    throw new AppError("VALIDATION_FAILED", "Enter a whole number of points, positive or negative, other than zero.", {
      fieldErrors: { points: "Enter a whole number other than zero." },
    });
  }
  if (Math.abs(points) > ADJUSTMENT_MAX_ABS) {
    throw new AppError("VALIDATION_FAILED", `An adjustment can't move a member by more than ${ADJUSTMENT_MAX_ABS} points.`, {
      fieldErrors: { points: `At most ${ADJUSTMENT_MAX_ABS} either way.` },
    });
  }
  // Ten characters AND more than one word. "correction" is exactly ten
  // characters, so a length floor alone lets through the very reason this
  // rule exists to refuse; a single word can't say what happened. The
  // database enforces the length floor too (PointAward_adjustment_fields_check).
  const trimmed = reason.trim();
  if (trimmed.length < ADJUSTMENT_REASON_MIN_LENGTH || !/\S\s+\S/.test(trimmed)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Give a reason of at least ${ADJUSTMENT_REASON_MIN_LENGTH} characters that says what happened — "correction" is not a reason.`,
      { fieldErrors: { reason: `At least ${ADJUSTMENT_REASON_MIN_LENGTH} characters, more than one word.` } },
    );
  }
  return trimmed;
}

/** The season an adjustment is stamped with. Refuses an unset Config.SEASON: an adjustment stamped "" would never count (see lib/points.ts awardCountsForSeason). */
async function adjustmentSeason(orgId: string): Promise<string> {
  const season = (await getConfigValue(orgId, "SEASON", "")).trim();
  if (!season) {
    throw new AppError("VALIDATION_FAILED", "Set the current season in Settings before adjusting points — an adjustment belongs to a season.");
  }
  return season;
}

export interface PointAdjustmentRow extends PointAward {
  awardedByName: string;
  revokedByName: string;
  relatedEventName: string;
  /** False for a revoked adjustment or one from another season — listed, but not in the total. */
  counts: boolean;
}

export interface MemberPointsPanel {
  /** The TRUE breakdown — possibly negative; this is an admin surface. */
  breakdown: PointBreakdown;
  season: string;
  eligible: boolean;
  role: Role;
  /** Rank on the member board right now, or null when they aren't on it (ineligible, or not GENERAL). */
  rank: number | null;
  totalRanked: number;
  /** Every adjustment ever made to this member, newest first — revoked and other-season ones included, flagged by `counts`. */
  adjustments: PointAdjustmentRow[];
}

/** Everything the Points panel on /admin/members/[id] shows. Reads live standings (never the cache): an admin about to adjust someone needs the rank as it is right now. */
export async function getMemberPointsPanel(orgId: string, email: string): Promise<MemberPointsPanel> {
  const e = normalizeEmail(email);
  const member = await getMember(orgId, e);
  if (!member) throw new AppError("NOT_FOUND", "Member not found");
  const [breakdown, season, standings, rows] = await Promise.all([
    getMemberBreakdown(orgId, e),
    getConfigValue(orgId, "SEASON", ""),
    getStandings(orgId),
    prisma.pointAward.findMany({
      where: { orgId, userId: member.id, kind: DbAwardKind.ADJUSTMENT },
      include: {
        user: { select: { email: true } },
        awardedBy: { select: { firstName: true, lastName: true, email: true } },
        revokedBy: { select: { firstName: true, lastName: true, email: true } },
        relatedEvent: { select: { name: true, deletedAt: true } },
      },
      orderBy: { awardedAt: "desc" },
    }),
  ]);
  const summary = summaryFor(e, standings);
  const name = (u: { firstName: string; lastName: string; email: string } | null) =>
    u ? memberDisplayName(u.firstName, u.lastName, u.email) : "";
  return {
    breakdown,
    season,
    eligible: isEligible(member, season),
    role: member.role,
    rank: summary.rank,
    totalRanked: summary.totalRanked,
    adjustments: rows.map((r) => {
      const award = pointAwardToDomain(r);
      return {
        ...award,
        awardedByName: name(r.awardedBy),
        revokedByName: name(r.revokedBy),
        relatedEventName: r.relatedEvent ? `${r.relatedEvent.name}${r.relatedEvent.deletedAt ? " (in trash)" : ""}` : "",
        counts: award.revokedAt === null && awardCountsForSeason(award, season),
      };
    }),
  };
}

export interface AdjustmentImpactMember {
  email: string;
  name: string;
  role: Role;
  eligible: boolean;
  currentTotal: number;
  newTotal: number;
  /** Null when this member isn't on the member board (ineligible or not GENERAL) — before and after alike, since an adjustment changes neither. */
  currentRank: number | null;
  projectedRank: number | null;
}

export interface AdjustmentImpact {
  points: number;
  members: AdjustmentImpactMember[];
  /** Every targeted member counted once — the bulk confirmation's "12 members". */
  count: number;
  /** points × count: how many points this moves in total. */
  totalPointsAffected: number;
  totalRanked: number;
  /** Targets whose adjustment will not show on any board today — E-Board/Admin (whose internal board ignores adjustments entirely) and ineligible members. */
  offBoard: Array<{ email: string; name: string; why: "eboard" | "admin" | "ineligible" | "guest" }>;
  /** Emails that didn't resolve to a live member. */
  notFound: string[];
}

/**
 * What an adjustment would do, computed before anything is written: each
 * target's current and new TRUE total, and their current and projected rank.
 * Projection re-ranks the live board with every target's delta applied at once
 * (lib/points.ts projectStandings), so a bulk adjustment's ranks account for
 * the targets moving past each other, not just past everyone else.
 */
export async function previewPointAdjustment(orgId: string, emails: string[], points: number): Promise<AdjustmentImpact> {
  const wanted = [...new Set(emails.map((e) => normalizeEmail(e)))].filter(Boolean);
  const [users, standings, season] = await Promise.all([
    prisma.user.findMany({ where: { orgId, email: { in: wanted }, ...LIVE } }),
    getStandings(orgId),
    getConfigValue(orgId, "SEASON", ""),
  ]);
  const members = users.map(userToMember);
  const found = new Set(members.map((m) => m.email));
  const totals = await trueTotalsFor(orgId, members, season);

  const deltas = new Map(members.map((m) => [m.email.toLowerCase(), points]));
  const projected = projectStandings(standings, deltas);
  const rankOf = (board: Standing[], email: string) => board.find((s) => s.email.toLowerCase() === email.toLowerCase())?.rank ?? null;

  const impactMembers: AdjustmentImpactMember[] = members
    .map((m) => {
      const currentTotal = totals.get(m.email)?.total ?? 0;
      return {
        email: m.email,
        name: memberDisplayName(m.firstName, m.lastName, m.email),
        role: m.role,
        eligible: isEligible(m, season),
        currentTotal,
        newTotal: currentTotal + points,
        currentRank: rankOf(standings, m.email),
        projectedRank: rankOf(projected, m.email),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const offBoard: AdjustmentImpact["offBoard"] = [];
  for (const m of impactMembers) {
    if (m.role === "eboard" || m.role === "admin" || m.role === "guest") offBoard.push({ email: m.email, name: m.name, why: m.role });
    else if (!m.eligible) offBoard.push({ email: m.email, name: m.name, why: "ineligible" });
  }

  return {
    points,
    members: impactMembers,
    count: impactMembers.length,
    totalPointsAffected: points * impactMembers.length,
    totalRanked: standings.length,
    offBoard,
    notFound: wanted.filter((e) => !found.has(e)),
  };
}

export interface CreatePointAdjustmentInput {
  orgId: string;
  email: string;
  points: number;
  reason: string;
  /** Optional link to the event this corrects. Informational — it never makes the adjustment part of that event's counts. */
  relatedEventId?: string | null;
  actor: string;
}

export async function createPointAdjustment(input: CreatePointAdjustmentInput): Promise<PointAward> {
  const [award] = await createPointAdjustments({ ...input, emails: [input.email] });
  return award;
}

/**
 * One adjustment per member, all in ONE transaction — a bulk adjustment with a
 * shared reason either lands for every selected member or for none, so there
 * is never a half-applied batch to reconcile. Each row still gets its own
 * AdminLog entry: the audit trail names every person moved.
 *
 * Two adjustments on the same member are independent rows and both apply;
 * there is no "replace". Undoing one is revokePointAdjustment.
 */
export async function createPointAdjustments(
  input: Omit<CreatePointAdjustmentInput, "email"> & { emails: string[] },
): Promise<PointAward[]> {
  const { orgId } = input;
  const reason = validateAdjustment(input.points, input.reason);
  const emails = [...new Set(input.emails.map((e) => normalizeEmail(e)))].filter(Boolean);
  if (emails.length === 0) throw new AppError("VALIDATION_FAILED", "Select at least one member.");
  const season = await adjustmentSeason(orgId);

  const awards = await prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({ where: { orgId, email: { in: emails }, ...LIVE } });
    const missing = emails.filter((e) => !users.some((u) => u.email === e));
    if (missing.length > 0) throw new AppError("NOT_FOUND", `Member not found: ${missing.join(", ")}`);

    let relatedEventName = "";
    if (input.relatedEventId) {
      const event = await tx.event.findFirst({ where: { id: input.relatedEventId, orgId, ...LIVE }, select: { name: true } });
      if (!event) throw new AppError("NOT_FOUND", "The linked event wasn't found — it may be in the trash.");
      relatedEventName = event.name;
    }
    const actorId = await actorUserId(tx, orgId, input.actor);

    const created: PointAward[] = [];
    for (const user of users) {
      const row = await tx.pointAward.create({
        data: {
          orgId,
          userId: user.id,
          kind: DbAwardKind.ADJUSTMENT,
          points: input.points,
          reason,
          season,
          relatedEventId: input.relatedEventId || null,
          awardedById: actorId,
        },
        include: { user: { select: { email: true } } },
      });
      await logAdminAction(tx, orgId, {
        actor: input.actor,
        action: "adjust_points",
        target: user.email,
        detail: `${formatSigned(input.points)} (${season})${relatedEventName ? ` re: ${relatedEventName}` : ""} — ${reason}`,
      });
      created.push(pointAwardToDomain(row));
    }
    return created;
  });

  invalidateStandings(orgId, season);
  return awards;
}

/** Revoking is the only undo — the row stays, with who revoked it and why, and drops out of the sum on the next read. */
export async function revokePointAdjustment(orgId: string, id: string, actor: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "A note is required to revoke an adjustment.");
  await prisma.$transaction(async (tx) => {
    const existing = await tx.pointAward.findFirst({
      where: { id, orgId, kind: DbAwardKind.ADJUSTMENT, user: LIVE },
      include: { user: { select: { email: true } } },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Adjustment not found");
    if (existing.revokedAt) throw new AppError("VALIDATION_FAILED", "This adjustment was already revoked.");
    await tx.pointAward.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById: await actorUserId(tx, orgId, actor), revokeNote: trimmed },
    });
    await logAdminAction(tx, orgId, {
      actor,
      action: "revoke_adjustment",
      target: existing.user.email,
      detail: `${formatSigned(existing.points)} (${existing.season ?? "no season"}) revoked — ${trimmed}`,
    });
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

// ---------------------------------------------------------------------------
// Trash bin.
//
// Trashing sets deletedAt/deletedById/deleteReason/permanentDeleteAt and
// nothing else: every row the item owns is kept, and every read in this module
// stops seeing it (see LIVE / liveRegistrationWhere at the top of the file).
// Restoring clears the four columns — no backfill, no recomputation, because
// every total here is derived on read.
//
// Permanent deletion (purge*) is the only path that destroys anything, and it
// refuses to run without a backup: it writes a JSON snapshot of every row it is
// about to remove first, and stops with BACKUP_UNAVAILABLE when there is
// nowhere to write it (lib/storage.ts backupStorageStatus).
// ---------------------------------------------------------------------------

export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getTrashRetentionDays(orgId: string): Promise<number> {
  const parsed = Number(await getConfigValue(orgId, "TRASH_RETENTION_DAYS", String(DEFAULT_TRASH_RETENTION_DAYS)));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= TRASH_RETENTION_MAX_DAYS ? parsed : DEFAULT_TRASH_RETENTION_DAYS;
}

/**
 * Changes Config.TRASH_RETENTION_DAYS and recomputes permanentDeleteAt for
 * everything already in the bin (deletedAt + the new value), in the same
 * transaction as the setting — the bin never shows dates from the old rule.
 * Shortening it can put items past due; the next sweep takes them.
 */
export async function setTrashRetentionDays(
  orgId: string,
  days: number,
  actor: string,
): Promise<{ members: number; events: number }> {
  if (!Number.isInteger(days) || days < 1 || days > TRASH_RETENTION_MAX_DAYS) {
    throw new AppError("VALIDATION_FAILED", `Retention must be a whole number of days from 1 to ${TRASH_RETENTION_MAX_DAYS}.`, {
      fieldErrors: { trashRetentionDays: `1 to ${TRASH_RETENTION_MAX_DAYS} days.` },
    });
  }
  return prisma.$transaction(async (tx) => {
    await tx.config.upsert({
      where: { orgId_key: { orgId, key: "TRASH_RETENTION_DAYS" } },
      update: { value: String(days) },
      create: { orgId, key: "TRASH_RETENTION_DAYS", value: String(days) },
    });
    const members = await tx.$executeRaw`
      UPDATE "User" SET "permanentDeleteAt" = "deletedAt" + make_interval(days => ${days}::int)
      WHERE "orgId" = ${orgId} AND "deletedAt" IS NOT NULL`;
    const events = await tx.$executeRaw`
      UPDATE "Event" SET "permanentDeleteAt" = "deletedAt" + make_interval(days => ${days}::int)
      WHERE "orgId" = ${orgId} AND "deletedAt" IS NOT NULL`;
    await logAdminAction(tx, orgId, {
      actor,
      action: "update_config",
      target: "TRASH_RETENTION_DAYS",
      detail: `${days} — recomputed ${members} member(s), ${events} event(s) already in the trash`,
    });
    return { members, events };
  });
}

/**
 * The TRUE breakdown for one member by id, whether or not they're trashed —
 * the purge log's "points at time of deletion" and the trash row's points.
 * Same inputs as the standings computation otherwise: live events only, their
 * own awards, the current season.
 */
async function breakdownForUserId(orgId: string, userId: string): Promise<{ breakdown: PointBreakdown; registrations: number }> {
  const [user, registrations, awards, groups, season] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, orgId } }),
    prisma.registration.findMany({ where: { userId, event: { orgId, ...LIVE } }, include: REGISTRATION_ATTENDANCE_INCLUDE }),
    prisma.pointAward.findMany({
      where: { orgId, userId, OR: [{ eventId: null }, { event: LIVE }] },
      include: { user: { select: { email: true } } },
    }),
    getGroupBonusInputs(orgId),
    getConfigValue(orgId, "SEASON", ""),
  ]);
  const breakdown = memberTotal(
    { role: user ? roleFromDb(user.role) : "general" },
    registrations.map(registrationToAttendance),
    awards.map(pointAwardToDomain),
    groups,
    new Date(),
    season,
  );
  return { breakdown, registrations: registrations.length };
}

export interface TrashMemberPreview {
  email: string;
  name: string;
  role: Role;
  registrations: number;
  /** TRUE total — what stops counting while they're trashed. */
  points: number;
  activeAdjustments: number;
  files: number;
  activeGrants: number;
  retentionDays: number;
  /** Set when trashing is refused outright — self, or the last admin. */
  blockedReason: string | null;
}

/** Why a member can't be trashed at all, or null. Self-trash would sign the admin out mid-action; the last admin would lock everyone out of /admin — same guard as setMemberRole. */
async function trashMemberBlock(
  tx: Tx | typeof prisma,
  orgId: string,
  user: { id: string; email: string; role: DbRole },
  actor: string,
): Promise<{ code: "FORBIDDEN" | "LAST_ADMIN"; message: string } | null> {
  if (user.email === normalizeEmail(actor)) return { code: "FORBIDDEN", message: "You can't move your own account to the trash." };
  if (user.role === DbRole.ADMIN) {
    const otherAdmins = await tx.user.count({ where: { orgId, role: DbRole.ADMIN, id: { not: user.id }, ...LIVE } });
    if (otherAdmins === 0) return { code: "LAST_ADMIN", message: "Can't trash the last Admin — promote another account first." };
  }
  return null;
}

export async function previewTrashMember(orgId: string, email: string, actor: string): Promise<TrashMemberPreview> {
  const e = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
  if (!user) throw new AppError("NOT_FOUND", "Member not found");
  const [{ breakdown, registrations }, adjustments, files, grants, retentionDays, block] = await Promise.all([
    breakdownForUserId(orgId, user.id),
    prisma.pointAward.count({ where: { orgId, userId: user.id, kind: DbAwardKind.ADJUSTMENT, revokedAt: null } }),
    prisma.uploadedFile.count({ where: { orgId, userId: user.id } }),
    prisma.permissionGrant.count({ where: { orgId, userId: user.id, revokedAt: null } }),
    getTrashRetentionDays(orgId),
    trashMemberBlock(prisma, orgId, user, actor),
  ]);
  return {
    email: user.email,
    name: memberDisplayName(user.firstName, user.lastName, user.email),
    role: roleFromDb(user.role),
    registrations,
    points: breakdown.total,
    activeAdjustments: adjustments,
    files,
    activeGrants: grants,
    retentionDays,
    blockedReason: block?.message ?? null,
  };
}

/**
 * Moves a member to the trash. They disappear from every roster, board,
 * standings computation and export; they can't sign in (getAuthRecord and
 * getSessionUser both filter them), and a session they already had ends on its
 * next request. Their active permission grants are revoked — and stay revoked
 * on restore; a grant is re-issued deliberately, never resurrected.
 *
 * KEPT, and counting again on restore: every Registration (the events they
 * attended keep their headcount, and they still compete for Monthly Champion —
 * see calculateMonthlyChampions), every award including adjustments (not
 * revoked, just not counted while trashed), and every uploaded file.
 */
export async function trashMember(orgId: string, email: string, reason: string, actor: string, now: Date = new Date()): Promise<void> {
  const e = normalizeEmail(email);
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "A reason is required to move a member to the trash.");
  const retentionDays = await getTrashRetentionDays(orgId);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { orgId_email: { orgId, email: e }, ...LIVE } });
    if (!user) throw new AppError("NOT_FOUND", "Member not found");
    const blocked = await trashMemberBlock(tx, orgId, user, actor);
    if (blocked) throw new AppError(blocked.code, blocked.message);
    const actorId = await actorUserId(tx, orgId, actor);

    await tx.user.update({
      where: { id: user.id },
      data: {
        deletedAt: now,
        deletedById: actorId,
        deleteReason: trimmed,
        permanentDeleteAt: new Date(now.getTime() + retentionDays * DAY_MS),
      },
    });
    const revokedGrants = await tx.permissionGrant.updateMany({
      where: { orgId, userId: user.id, revokedAt: null },
      data: { revokedAt: now, revokedById: actorId },
    });
    await logAdminAction(tx, orgId, {
      actor,
      action: "trash_member",
      target: e,
      detail: `${trimmed} — permanently deletes in ${retentionDays} days${revokedGrants.count > 0 ? `; ${revokedGrants.count} permission grant(s) revoked` : ""}`,
    });
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

/** Clears the four trash columns: the member is back everywhere, with every registration, award and adjustment counting again exactly as before. Permission grants revoked on the way in are NOT restored. */
export async function restoreMember(orgId: string, userId: string, actor: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, orgId, deletedAt: { not: null } } });
    if (!user) throw new AppError("NOT_FOUND", "That member isn't in the trash.");
    await tx.user.update({
      where: { id: user.id },
      data: { deletedAt: null, deletedById: null, deleteReason: null, permanentDeleteAt: null },
    });
    await logAdminAction(tx, orgId, { actor, action: "restore_member", target: user.email, detail: user.deleteReason ?? undefined });
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

/**
 * Month -> the last time its Monthly Engagement Champion was calculated. From
 * two sources: the calculate_monthly_champions AdminLog entry (written on every
 * run — including one that found no champion and so wrote no award), and the
 * awards themselves, for months calculated before that entry was always
 * written.
 */
export async function getCalculatedMonths(orgId: string): Promise<Map<string, Date>> {
  const [logs, awards] = await Promise.all([
    prisma.adminLog.findMany({
      where: { orgId, action: "calculate_monthly_champions", target: { not: null } },
      select: { target: true, createdAt: true },
    }),
    prisma.pointAward.findMany({
      where: { orgId, kind: DbAwardKind.MONTHLY_CHAMPION, periodMonth: { not: null } },
      select: { periodMonth: true, awardedAt: true },
    }),
  ]);
  const months = new Map<string, Date>();
  const note = (month: string | null, at: Date) => {
    if (!month) return;
    const prior = months.get(month);
    if (!prior || at > prior) months.set(month, at);
  };
  for (const l of logs) note(l.target, l.createdAt);
  for (const a of awards) note(a.periodMonth, a.awardedAt);
  return months;
}

/** "September 2026's Monthly Champion was calculated using this event…" — or null when the event can't have affected a calculated month. */
function championWarningFor(
  event: { closesAt: Date | null; category: { countsForMonthly: boolean } },
  registrations: number,
  calculated: Map<string, Date>,
  verb: "Deleting" | "Restoring",
): { month: string; message: string } | null {
  if (!event.closesAt || !event.category.countsForMonthly || registrations === 0) return null;
  const month = monthKeyOf(event.closesAt);
  if (!calculated.has(month)) return null;
  const label = formatMonthKey(month);
  return {
    month,
    message:
      verb === "Deleting"
        ? `${label}'s Monthly Champion was calculated using this event. Deleting it may change who qualified. Recalculate ${label} after deleting.`
        : `${label}'s Monthly Champion was calculated while this event was in the trash. Restoring it may change who qualified. Recalculate ${label} after restoring.`,
  };
}

export interface GroupBonusTransition {
  from: number;
  to: number;
  members: number;
}

export interface TrashEventGroupImpact {
  groupName: string;
  finalized: boolean;
  eventsBefore: number;
  eventsAfter: number;
  expectedEventCount: number;
  /** Tiers whose `min` can no longer be reached by anyone once this event is gone — tiers are absolute counts, never rescaled. */
  unreachableTiers: BonusTier[];
  transitions: GroupBonusTransition[];
}

export interface TrashEventPreview {
  eventId: string;
  eventName: string;
  /** Open for check-in right now — trashing is refused until it's closed. */
  windowOpen: boolean;
  /** Live members who checked in — every one of them loses this event from every count. */
  membersAffected: number;
  registrations: number;
  gameBonuses: number;
  championWarning: { month: string; message: string } | null;
  /** Set when the event's month already has a calculated Own the Month (House points) — flagged, never recalculated. */
  houseWarning: string | null;
  /** Non-revoked House awards this event contributed — every one stops counting while it's in the trash. */
  houseAwards: number;
  groupImpact: TrashEventGroupImpact | null;
  retentionDays: number;
}

/**
 * What trashing an event would do, before it happens. The attendance, the
 * Monthly Champion month (warned about, never recalculated here), and the NSBE
 * Week bonus, which IS derived and so changes on the next read — shown as
 * "N members go from +5 to +3" by running the real groupBonusFor on the
 * group's live events with and without this one.
 */
export async function previewTrashEvent(orgId: string, eventId: string, now: Date = new Date()): Promise<TrashEventPreview> {
  const row = await prisma.event.findFirst({ where: { id: eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
  if (!row) throw new AppError("NOT_FOUND", "Event not found");
  const event = eventToDomain(row);

  const [registrations, membersAffected, gameBonuses, calculated, retentionDays] = await Promise.all([
    prisma.registration.count({ where: { eventId, event: { orgId } } }),
    prisma.registration.count({ where: { eventId, user: LIVE } }),
    prisma.pointAward.count({ where: { orgId, eventId, revokedAt: null } }),
    getCalculatedMonths(orgId),
    getTrashRetentionDays(orgId),
  ]);

  let groupImpact: TrashEventGroupImpact | null = null;
  if (event.groupId) {
    const group = await prisma.eventGroup.findFirst({ where: { id: event.groupId, orgId }, include: GROUP_BONUS_EVENTS });
    if (group) {
      const tiers = (group.bonusTiers as unknown as BonusTier[] | null) ?? [];
      const before: GroupBonusInput = {
        events: group.events.map((e) => ({ eventId: e.id, status: eventStatusFromDb(e.status), closesAt: e.closesAt })),
        bonusTiers: tiers,
        finalizedAt: group.finalizedAt,
      };
      const after: GroupBonusInput = { ...before, events: before.events.filter((e) => e.eventId !== eventId) };
      const regs = await prisma.registration.findMany({
        where: { eventId: { in: before.events.map((e) => e.eventId) }, user: { orgId, role: DbRole.GENERAL, ...LIVE } },
        select: { userId: true, eventId: true },
      });
      const byUser = new Map<string, Array<{ eventId: string }>>();
      for (const r of regs) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), { eventId: r.eventId }]);
      const moves = new Map<string, GroupBonusTransition>();
      for (const mine of byUser.values()) {
        const from = groupBonusFor(mine, before, now);
        const to = groupBonusFor(mine, after, now);
        if (from === to) continue;
        const key = `${from}->${to}`;
        const t = moves.get(key) ?? { from, to, members: 0 };
        t.members += 1;
        moves.set(key, t);
      }
      groupImpact = {
        groupName: group.name,
        finalized: group.finalizedAt !== null,
        eventsBefore: before.events.length,
        eventsAfter: after.events.length,
        expectedEventCount: group.expectedEventCount,
        unreachableTiers: tiers.filter((t) => t.min > after.events.length && t.min <= before.events.length),
        transitions: [...moves.values()].sort((a, b) => b.members - a.members),
      };
    }
  }

  return {
    eventId,
    eventName: event.name,
    windowOpen: isOpen(event, now),
    membersAffected,
    registrations,
    gameBonuses,
    championWarning: championWarningFor(event, registrations, calculated, "Deleting"),
    houseWarning: await houseMonthWarningFor(orgId, row, "Deleting"),
    houseAwards: await prisma.housePointAward.count({ where: { orgId, eventId, revokedAt: null, points: { not: 0 } } }),
    groupImpact,
    retentionDays,
  };
}

/**
 * Moves an event to the trash. Everything it contributed stops counting on the
 * next read — every registration drops out of every attendance count, points
 * total, NSBE Week tier and Monthly Champion count, and its game bonuses stop
 * counting — while every row is kept, so restoring puts every count back
 * exactly. Refused while its check-in window is open.
 *
 * A Monthly Champion already calculated for its month is NOT recalculated:
 * silently changing who won a month is worse than telling someone.
 * previewTrashEvent warns, and /admin/awards flags the month.
 */
export async function trashEvent(
  orgId: string,
  eventId: string,
  reason: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "A reason is required to move an event to the trash.");
  const retentionDays = await getTrashRetentionDays(orgId);
  await prisma.$transaction(async (tx) => {
    const row = await tx.event.findFirst({ where: { id: eventId, orgId, ...LIVE }, include: EVENT_INCLUDE });
    if (!row) throw new AppError("NOT_FOUND", "Event not found");
    if (isOpen(eventToDomain(row), now)) {
      throw new AppError("VALIDATION_FAILED", "This event is open for check-in right now. Close it first, then delete it.");
    }
    const registrations = await tx.registration.count({ where: { eventId } });
    await tx.event.update({
      where: { id: eventId },
      data: {
        deletedAt: now,
        deletedById: await actorUserId(tx, orgId, actor),
        deleteReason: trimmed,
        permanentDeleteAt: new Date(now.getTime() + retentionDays * DAY_MS),
      },
    });
    await logAdminAction(tx, orgId, {
      actor,
      action: "trash_event",
      target: eventId,
      detail: `${row.name} (${registrations} registration(s)) — ${trimmed} — permanently deletes in ${retentionDays} days`,
    });
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
}

/** Clears the four trash columns — every count the event contributed comes back exactly, because nothing was ever deleted. Returns a champion warning when its month was calculated while it was in the trash. */
export async function restoreEvent(orgId: string, eventId: string, actor: string): Promise<{ championWarning: string | null }> {
  const warning = await prisma.$transaction(async (tx) => {
    const row = await tx.event.findFirst({ where: { id: eventId, orgId, deletedAt: { not: null } }, include: EVENT_INCLUDE });
    if (!row) throw new AppError("NOT_FOUND", "That event isn't in the trash.");
    const registrations = await tx.registration.count({ where: { eventId } });
    await tx.event.update({
      where: { id: eventId },
      // House awards were never touched by the trash, so they come back
      // exactly — houseScoringStale stays as it was. houseChangedAt is bumped
      // so a House month calculated while the event was out is flagged.
      data: {
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        permanentDeleteAt: null,
        ...(hasHouseFlags(row) ? { houseChangedAt: new Date() } : {}),
      },
    });
    await logAdminAction(tx, orgId, { actor, action: "restore_event", target: eventId, detail: row.name });

    const calculated = await getCalculatedMonths(orgId);
    const w = championWarningFor(row, registrations, calculated, "Restoring");
    // Only when it was calculated WHILE this event was out — a calculation
    // from before the delete already counted it, and restoring puts it back.
    const champion = w && row.deletedAt && (calculated.get(w.month) ?? new Date(0)) > row.deletedAt ? w.message : null;
    // Same rule for the House track's Own the Month.
    let house: string | null = null;
    if (row.closesAt && row.countsForMonthlyHouse && row.deletedAt) {
      const houseCalculatedAt = (await getCalculatedHouseMonths(orgId)).get(monthKeyOf(row.closesAt));
      if (houseCalculatedAt && houseCalculatedAt > row.deletedAt) house = await houseMonthWarningFor(orgId, row, "Restoring");
    }
    return [champion, house].filter(Boolean).join(" ") || null;
  });
  invalidateStandings(orgId, await getConfigValue(orgId, "SEASON", ""));
  return { championWarning: warning };
}

export interface MonthNeedingRecalculation {
  month: string;
  label: string;
  events: Array<{ eventId: string; name: string; deletedAt: Date | null }>;
}

/**
 * Calculated months that a trashed event may have changed — the
 * "may need recalculation" flag on /admin/awards. A month qualifies when an
 * event in it that could have affected the result (countsForMonthly, with at
 * least one registration) went into the trash AFTER the month's last
 * calculation. Recalculating clears the flag; restoring the event does too.
 */
export async function getMonthsNeedingRecalculation(orgId: string): Promise<MonthNeedingRecalculation[]> {
  const [calculated, trashed] = await Promise.all([
    getCalculatedMonths(orgId),
    prisma.event.findMany({
      where: { orgId, deletedAt: { not: null }, closesAt: { not: null }, category: { countsForMonthly: true }, registrations: { some: {} } },
      select: { id: true, name: true, closesAt: true, deletedAt: true },
    }),
  ]);
  const byMonth = new Map<string, MonthNeedingRecalculation>();
  for (const e of trashed) {
    const month = monthKeyOf(e.closesAt!);
    const calculatedAt = calculated.get(month);
    if (!calculatedAt || !e.deletedAt || calculatedAt > e.deletedAt) continue;
    const entry = byMonth.get(month) ?? { month, label: formatMonthKey(month), events: [] };
    entry.events.push({ eventId: e.id, name: e.name, deletedAt: e.deletedAt });
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export interface TrashedMemberRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  deletedAt: Date;
  deletedByName: string;
  deleteReason: string;
  permanentDeleteAt: Date;
  registrations: number;
  files: number;
}

export interface TrashedEventRow {
  id: string;
  name: string;
  date: Date | null;
  categoryName: string;
  deletedAt: Date;
  deletedByName: string;
  deleteReason: string;
  permanentDeleteAt: Date;
  registrations: number;
}

export interface TrashListing {
  members: TrashedMemberRow[];
  events: TrashedEventRow[];
  retentionDays: number;
  backup: BackupStorageStatus;
  lastSweepAt: Date | null;
}

/** /admin/trash — both tabs, each sorted soonest-to-delete first. */
export async function getTrash(orgId: string): Promise<TrashListing> {
  const [users, events, retentionDays, lastSweepRaw] = await Promise.all([
    prisma.user.findMany({
      where: { orgId, deletedAt: { not: null } },
      include: { _count: { select: { registrations: true, uploadedFiles: true } } },
      orderBy: { permanentDeleteAt: "asc" },
    }),
    prisma.event.findMany({
      where: { orgId, deletedAt: { not: null } },
      include: { ...EVENT_INCLUDE, _count: { select: { registrations: true } } },
      orderBy: { permanentDeleteAt: "asc" },
    }),
    getTrashRetentionDays(orgId),
    getConfigValue(orgId, TRASH_SWEEP_KEY, ""),
  ]);
  const deleterIds = [...new Set([...users, ...events].map((r) => r.deletedById).filter((id): id is string => Boolean(id)))];
  const deleters =
    deleterIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: deleterIds } }, select: { id: true, firstName: true, lastName: true, email: true } });
  const nameById = new Map(deleters.map((d) => [d.id, memberDisplayName(d.firstName, d.lastName, d.email)]));
  const lastSweep = lastSweepRaw ? new Date(lastSweepRaw) : null;

  return {
    members: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: memberDisplayName(u.firstName, u.lastName, u.email),
      role: roleFromDb(u.role),
      deletedAt: u.deletedAt!,
      deletedByName: nameById.get(u.deletedById ?? "") ?? "",
      deleteReason: u.deleteReason ?? "",
      permanentDeleteAt: u.permanentDeleteAt!,
      registrations: u._count.registrations,
      files: u._count.uploadedFiles,
    })),
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      categoryName: e.category.name,
      deletedAt: e.deletedAt!,
      deletedByName: nameById.get(e.deletedById ?? "") ?? "",
      deleteReason: e.deleteReason ?? "",
      permanentDeleteAt: e.permanentDeleteAt!,
      registrations: e._count.registrations,
    })),
    retentionDays,
    backup: backupStorageStatus(),
    lastSweepAt: lastSweep && !Number.isNaN(lastSweep.getTime()) ? lastSweep : null,
  };
}

// --- Permanent deletion ------------------------------------------------------

export interface PurgeResult {
  kind: "member" | "event";
  id: string;
  label: string;
  snapshotKey: string;
  registrations: number;
  answers: number;
  awards: number;
  grants: number;
  files: number;
  /** storageKeys whose blob delete failed after the rows were gone — logged to AdminLog for a retry, never silently dropped. */
  blobFailures: string[];
}

function assertBackupAvailable(): void {
  const status = backupStorageStatus();
  if (!status.configured) {
    throw new AppError(
      "BACKUP_UNAVAILABLE",
      `Permanent deletion is blocked: backup storage isn't configured (${status.reason}). Nothing was deleted.`,
    );
  }
}

/** Writes the pre-deletion snapshot — every row about to be destroyed, in full — and returns its key. Throws (so nothing is deleted) if the write fails. */
async function writePurgeSnapshot(orgId: string, kind: "member" | "event", id: string, rows: unknown, now: Date): Promise<string> {
  const key = `trash-purges/${orgId}/${now.toISOString().replace(/[:.]/g, "-")}-${kind}-${id}.json`;
  const body = Buffer.from(JSON.stringify({ kind, id, orgId, takenAt: now.toISOString(), rows }, null, 2), "utf8");
  try {
    await backupStorage.put(key, body);
  } catch (err) {
    throw new AppError("BACKUP_UNAVAILABLE", "Couldn't write the backup snapshot, so nothing was deleted. Try again, or check backup storage.", {
      cause: err,
    });
  }
  return key;
}

/**
 * Permanently deletes a TRASHED member and everything they own: registrations
 * (and their answers, by cascade), every PointAward including adjustments,
 * permission grants, UploadedFile rows AND the stored blobs behind them.
 *
 * Order, deliberately: backup check → snapshot (every row, in full) → one
 * transaction deleting the rows and writing the AdminLog entry → blob deletes.
 * Blobs go last because they can't join the transaction: deleting them first
 * would leave a restorable member pointing at files that no longer exist if
 * the transaction then failed. A blob that fails to delete afterwards is
 * reported and logged with its key, not swallowed.
 *
 * `confirm`, when given, must be the member's email — the typed confirmation
 * the "Delete now" dialog requires, checked here rather than trusted from the
 * client. The scheduled sweep passes none.
 */
export async function purgeTrashedMember(
  orgId: string,
  userId: string,
  actor: string,
  options: { confirm?: string; now?: Date } = {},
): Promise<PurgeResult> {
  assertBackupAvailable();
  const now = options.now ?? new Date();
  const user = await prisma.user.findFirst({ where: { id: userId, orgId, deletedAt: { not: null } } });
  if (!user) throw new AppError("NOT_FOUND", "That member isn't in the trash.");
  if (options.confirm !== undefined && normalizeEmail(options.confirm) !== user.email) {
    throw new AppError("VALIDATION_FAILED", "Type the member's email exactly to confirm.", { fieldErrors: { confirm: "Doesn't match." } });
  }

  const [registrations, awards, grants, files, { breakdown }] = await Promise.all([
    prisma.registration.findMany({ where: { userId }, include: { answers: true } }),
    prisma.pointAward.findMany({ where: { userId } }),
    prisma.permissionGrant.findMany({ where: { userId } }),
    prisma.uploadedFile.findMany({ where: { userId } }),
    breakdownForUserId(orgId, userId),
  ]);
  const answers = registrations.reduce((n, r) => n + r.answers.length, 0);
  const snapshotKey = await writePurgeSnapshot(orgId, "member", userId, { user, registrations, awards, grants, files }, now);

  await prisma.$transaction(async (tx) => {
    // Answers go with their registrations (onDelete: Cascade), grants with the
    // user; the rest are RESTRICT and are deleted explicitly, children first.
    await tx.registration.deleteMany({ where: { userId } });
    await tx.pointAward.deleteMany({ where: { userId } });
    await tx.uploadedFile.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
    await logAdminAction(tx, orgId, {
      actor,
      action: "purge_member",
      target: user.email,
      detail:
        `${memberDisplayName(user.firstName, user.lastName, user.email)} <${user.email}> (${user.role}) permanently deleted — ` +
        `${registrations.length} registration(s), ${answers} answer(s), ${awards.length} award(s) ` +
        `(${awards.filter((a) => a.kind === DbAwardKind.ADJUSTMENT).length} adjustment(s)), ${grants.length} grant(s), ` +
        `${files.length} file(s); ${breakdown.total} points at deletion; trashed ${user.deletedAt?.toISOString()} — ` +
        `${user.deleteReason ?? ""}; snapshot ${snapshotKey}`,
    });
  });

  const blobFailures: string[] = [];
  for (const f of files) {
    try {
      await storage.delete(f.storageKey);
    } catch (err) {
      console.error("[trash] blob delete failed", { storageKey: f.storageKey, err });
      blobFailures.push(f.storageKey);
    }
  }
  if (blobFailures.length > 0) {
    await logSystemAdminEvent(orgId, {
      actor,
      action: "purge_blob_failed",
      target: user.email,
      detail: `Rows deleted, but these stored files were not: ${blobFailures.join(", ")}`,
    });
  }

  return {
    kind: "member",
    id: userId,
    label: user.email,
    snapshotKey,
    registrations: registrations.length,
    answers,
    awards: awards.length,
    grants: grants.length,
    files: files.length,
    blobFailures,
  };
}

/**
 * Permanently deletes a TRASHED event: its registrations (and answers), its
 * game bonuses, its form fields (cascade), and the event. An adjustment that
 * merely links to it keeps its points and loses the link (relatedEventId SET
 * NULL) — it was a correction about a member, not part of the event. Same
 * backup → snapshot → transaction order as purgeTrashedMember; `confirm`, when
 * given, must be the event's name.
 */
export async function purgeTrashedEvent(
  orgId: string,
  eventId: string,
  actor: string,
  options: { confirm?: string; now?: Date } = {},
): Promise<PurgeResult> {
  assertBackupAvailable();
  const now = options.now ?? new Date();
  const event = await prisma.event.findFirst({ where: { id: eventId, orgId, deletedAt: { not: null } } });
  if (!event) throw new AppError("NOT_FOUND", "That event isn't in the trash.");
  if (options.confirm !== undefined && options.confirm.trim() !== event.name.trim()) {
    throw new AppError("VALIDATION_FAILED", "Type the event name exactly to confirm.", { fieldErrors: { confirm: "Doesn't match." } });
  }

  const [registrations, awards, fields, linkedAdjustments, houseAwards] = await Promise.all([
    prisma.registration.findMany({ where: { eventId }, include: { answers: true, user: { select: { email: true } } } }),
    prisma.pointAward.findMany({ where: { eventId } }),
    prisma.formField.findMany({ where: { eventId } }),
    prisma.pointAward.count({ where: { relatedEventId: eventId } }),
    // Cascade-deleted with the event (HousePointAward.event onDelete: Cascade) — kept in the snapshot.
    getHouseAwardsForEvent(orgId, eventId),
  ]);
  const answers = registrations.reduce((n, r) => n + r.answers.length, 0);
  const registrationPoints = registrations.reduce((n, r) => n + r.pointsAwarded, 0);
  const snapshotKey = await writePurgeSnapshot(orgId, "event", eventId, { event, fields, registrations, awards, houseAwards }, now);

  await prisma.$transaction(async (tx) => {
    await tx.registration.deleteMany({ where: { eventId } });
    await tx.pointAward.deleteMany({ where: { eventId } });
    await tx.event.delete({ where: { id: eventId } });
    await logAdminAction(tx, orgId, {
      actor,
      action: "purge_event",
      target: eventId,
      detail:
        `"${event.name}" (${event.date.toISOString().slice(0, 10)}) permanently deleted — ` +
        `${registrations.length} registration(s) worth ${registrationPoints} point(s) at check-in, ${answers} answer(s), ` +
        `${awards.length} game bonus award(s), ${houseAwards.length} House award row(s), ${fields.length} form field(s)` +
        `${linkedAdjustments > 0 ? `; ${linkedAdjustments} adjustment(s) kept, unlinked` : ""}; ` +
        `trashed ${event.deletedAt?.toISOString()} — ${event.deleteReason ?? ""}; snapshot ${snapshotKey}`,
    });
  });

  return {
    kind: "event",
    id: eventId,
    label: event.name,
    snapshotKey,
    registrations: registrations.length,
    answers,
    awards: awards.length,
    grants: 0,
    files: 0,
    blobFailures: [],
  };
}

export interface EmptyTrashPreview {
  members: number;
  events: number;
  registrations: number;
  answers: number;
  awards: number;
  adjustments: number;
  grants: number;
  files: number;
  fileBytes: number;
  memberLabels: string[];
  eventLabels: string[];
}

/** Exactly what "Empty trash" would destroy — counted from the same rows the purge functions delete. */
export async function previewEmptyTrash(orgId: string): Promise<EmptyTrashPreview> {
  const [users, events] = await Promise.all([
    prisma.user.findMany({ where: { orgId, deletedAt: { not: null } }, select: { id: true, email: true } }),
    prisma.event.findMany({ where: { orgId, deletedAt: { not: null } }, select: { id: true, name: true } }),
  ]);
  const userIds = users.map((u) => u.id);
  const eventIds = events.map((e) => e.id);
  // A registration can belong to a trashed member AND a trashed event — count it once.
  const registrationWhere: Prisma.RegistrationWhereInput = { OR: [{ userId: { in: userIds } }, { eventId: { in: eventIds } }] };
  const awardWhere: Prisma.PointAwardWhereInput = { orgId, OR: [{ userId: { in: userIds } }, { eventId: { in: eventIds } }] };
  const [registrations, answers, awards, adjustments, grants, files] = await Promise.all([
    prisma.registration.count({ where: registrationWhere }),
    prisma.answer.count({ where: { registration: registrationWhere } }),
    prisma.pointAward.count({ where: awardWhere }),
    prisma.pointAward.count({ where: { ...awardWhere, kind: DbAwardKind.ADJUSTMENT } }),
    prisma.permissionGrant.count({ where: { orgId, userId: { in: userIds } } }),
    prisma.uploadedFile.aggregate({ where: { orgId, userId: { in: userIds } }, _count: { _all: true }, _sum: { sizeBytes: true } }),
  ]);
  return {
    members: users.length,
    events: events.length,
    registrations,
    answers,
    awards,
    adjustments,
    grants,
    files: files._count._all,
    fileBytes: files._sum.sizeBytes ?? 0,
    memberLabels: users.map((u) => u.email),
    eventLabels: events.map((e) => e.name),
  };
}

export interface EmptyTrashResult {
  purged: PurgeResult[];
  /** An item that failed stops nothing else; it stays in the trash and is reported here. */
  failures: Array<{ kind: "member" | "event"; id: string; message: string }>;
}

async function purgeAll(
  orgId: string,
  actor: string,
  items: { members: Array<{ id: string }>; events: Array<{ id: string }> },
  now: Date,
): Promise<EmptyTrashResult> {
  const result: EmptyTrashResult = { purged: [], failures: [] };
  // Events first: a registration shared with a trashed member then goes with
  // the event, and the member purge that follows finds one fewer row.
  for (const e of items.events) {
    try {
      result.purged.push(await purgeTrashedEvent(orgId, e.id, actor, { now }));
    } catch (err) {
      if (err instanceof AppError && err.code === "BACKUP_UNAVAILABLE") throw err;
      result.failures.push({ kind: "event", id: e.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const m of items.members) {
    try {
      result.purged.push(await purgeTrashedMember(orgId, m.id, actor, { now }));
    } catch (err) {
      if (err instanceof AppError && err.code === "BACKUP_UNAVAILABLE") throw err;
      result.failures.push({ kind: "member", id: m.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Permanently deletes everything currently in the trash. `confirm` must be exactly "DELETE". Blocked outright without backup storage. */
export async function emptyTrash(orgId: string, actor: string, confirm: string, now: Date = new Date()): Promise<EmptyTrashResult> {
  if (confirm !== "DELETE") {
    throw new AppError("VALIDATION_FAILED", 'Type DELETE to empty the trash.', { fieldErrors: { confirm: 'Type DELETE exactly.' } });
  }
  assertBackupAvailable();
  const [members, events] = await Promise.all([
    prisma.user.findMany({ where: { orgId, deletedAt: { not: null } }, select: { id: true } }),
    prisma.event.findMany({ where: { orgId, deletedAt: { not: null } }, select: { id: true } }),
  ]);
  const result = await purgeAll(orgId, actor, { members, events }, now);
  await logSystemAdminEvent(orgId, {
    actor,
    action: "empty_trash",
    target: "trash",
    detail: `${result.purged.length} item(s) permanently deleted, ${result.failures.length} failed`,
  });
  return result;
}

// --- Expiry: the lazy sweep --------------------------------------------------

/** Config key holding the ISO timestamp of the last sweep that actually ran — the hourly rate limit. */
export const TRASH_SWEEP_KEY = "TRASH_SWEEP_LAST_RUN";
export const TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Claims this hour's sweep for the org, atomically: a conditional UPDATE that
 * only matches when the stored timestamp is over an hour old, or a first-ever
 * INSERT. Two concurrent page loads both try; Postgres lets exactly one win,
 * so the sweep runs at most once an hour however many admins are clicking.
 * ISO-8601 UTC strings of one fixed format sort as text in time order, which
 * is what makes the `lt` comparison valid.
 */
async function claimTrashSweep(orgId: string, now: Date): Promise<boolean> {
  const threshold = new Date(now.getTime() - TRASH_SWEEP_INTERVAL_MS).toISOString();
  const updated = await prisma.config.updateMany({
    where: { orgId, key: TRASH_SWEEP_KEY, value: { lte: threshold } },
    data: { value: now.toISOString() },
  });
  if (updated.count === 1) return true;
  try {
    await prisma.config.create({ data: { orgId, key: TRASH_SWEEP_KEY, value: now.toISOString() } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

export type TrashSweepResult =
  | { ran: false; reason: "rate_limited" }
  | { ran: false; reason: "backup_unconfigured"; detail: string }
  | { ran: true; purged: PurgeResult[]; failures: EmptyTrashResult["failures"] };

/**
 * Permanently deletes every trashed item past its permanentDeleteAt. There is
 * no cron in this project, so this runs lazily — on a load of /admin or
 * /admin/trash, at most once an hour (claimTrashSweep) — plus from the "Run
 * cleanup now" button (`force`, which skips the hourly limit but not the
 * backup check) and GET /api/cron/trash-sweep.
 *
 * Without backup storage it does not run at all: items sit in the trash past
 * their date rather than being destroyed with no snapshot behind them. That
 * state is logged (at most hourly, since it's behind the claim) and shown on
 * /admin/trash as "Retention paused".
 */
export async function runTrashSweep(
  orgId: string,
  options: { now?: Date; force?: boolean; actor?: string } = {},
): Promise<TrashSweepResult> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? "system";
  if (options.force) {
    await prisma.config.upsert({
      where: { orgId_key: { orgId, key: TRASH_SWEEP_KEY } },
      update: { value: now.toISOString() },
      create: { orgId, key: TRASH_SWEEP_KEY, value: now.toISOString() },
    });
  } else if (!(await claimTrashSweep(orgId, now))) {
    return { ran: false, reason: "rate_limited" };
  }

  const status = backupStorageStatus();
  if (!status.configured) {
    await logSystemAdminEvent(orgId, { actor, action: "trash_sweep_paused", target: "trash", detail: status.reason });
    return { ran: false, reason: "backup_unconfigured", detail: status.reason };
  }

  const [members, events] = await Promise.all([
    prisma.user.findMany({ where: { orgId, deletedAt: { not: null }, permanentDeleteAt: { lte: now } }, select: { id: true } }),
    prisma.event.findMany({ where: { orgId, deletedAt: { not: null }, permanentDeleteAt: { lte: now } }, select: { id: true } }),
  ]);
  if (members.length === 0 && events.length === 0) return { ran: true, purged: [], failures: [] };
  const result = await purgeAll(orgId, actor, { members, events }, now);
  await logSystemAdminEvent(orgId, {
    actor,
    action: "trash_sweep",
    target: "trash",
    detail: `${result.purged.length} expired item(s) permanently deleted, ${result.failures.length} failed`,
  });
  return { ran: true, ...result };
}

// ---------------------------------------------------------------------------
// Resume bundle (/admin/resumes) — the recruiter-facing export.
//
// Four things live here:
//
//   getResumeRosterCounts      the headline "38 of 52", over the whole roster
//   getResumeRoster            the list, filtered, WITHOUT storage keys
//   getResumeBundleRows        the same rows WITH storage keys, consent-only
//   createResumeBundleRequest  the AdminLog entry + the ticket the route needs
//
// The list and the bundle are deliberately different queries rather than one
// with a flag. The list shows every member who has a resume on file INCLUDING
// the ones with no consent timestamp, because an admin needs to see why the
// bundle is smaller than the roster. The bundle sees only the consenting ones,
// and is the only thing that ever touches a storageKey.
//
// GUEST rows are excluded from both, and from the denominator. A guest pass
// holder (see registerGuest) is not a member, has no /account and no signup
// wizard, and therefore never has a resume — counting them would only inflate
// the "of 52" into a number that doesn't match the chapter.
// ---------------------------------------------------------------------------

export interface ResumeFilters {
  q?: string;
  classification?: Classification | "all";
  major?: string;
  /** A House NAME as stored on User.house (see lib/houses.ts), or "none" for members with no House on file. */
  house?: string;
  eligible?: MemberTriFilter;
}

/** Everything the resume list and the bundle agree on: a live, non-guest member of this org with a resume attached. */
function resumeBaseWhere(orgId: string): Prisma.UserWhereInput {
  return { orgId, ...LIVE, role: { not: DbRole.GUEST }, resumeFileId: { not: null } };
}

/**
 * The ONE translation of the resume page's filter bar into SQL — same contract
 * as memberWhere above, and for the same reason: the count in the header and
 * the rows in the list have to be the same set, and "Download all" has to mean
 * "everything matching these filters", not "everything on screen".
 */
function resumeWhere(orgId: string, filters: ResumeFilters, currentSeason: string): Prisma.UserWhereInput {
  const q = (filters.q ?? "").trim();
  const and: Prisma.UserWhereInput[] = [];

  if (filters.classification && filters.classification !== "all") {
    and.push({ classification: classificationToDb(filters.classification) });
  }
  if (filters.major && filters.major !== "all") and.push({ major: filters.major });

  // "none" is the actionable case: a member with a resume but no House is
  // someone a House-scoped recruiter bundle would otherwise silently miss.
  if (filters.house === "none") and.push({ OR: [{ house: null }, { house: "" }] });
  else if (filters.house && filters.house !== "all") and.push({ house: filters.house });

  // isEligible's exact conditions, same as memberWhere — an unset SEASON
  // matches nobody rather than letting "" match everyone.
  const eligibleWhere: Prisma.UserWhereInput = currentSeason
    ? { duesPaidReported: true, nationalMemberReported: true, membershipSeason: currentSeason }
    : { id: { in: [] } };
  and.push(...tri(filters.eligible, eligibleWhere));

  if (q) {
    and.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { major: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  return { ...resumeBaseWhere(orgId), AND: and };
}

export interface ResumeRosterCounts {
  /** Every live, non-guest member — the "of 52". */
  members: number;
  /** ...of whom this many have a resume attached — the "38". */
  withResume: number;
  /** ...of whom this many also carry a consent timestamp. The bundle's real size. */
  withConsent: number;
}

/**
 * The headline numbers, UNFILTERED — this is the sentence an E-Board member
 * opens the page for, and it has to describe the chapter, not whatever filter
 * happens to be applied. The filtered counts come from getResumeRoster's rows.
 */
export async function getResumeRosterCounts(orgId: string): Promise<ResumeRosterCounts> {
  const live: Prisma.UserWhereInput = { orgId, ...LIVE, role: { not: DbRole.GUEST } };
  const [members, withResume, withConsent] = await Promise.all([
    prisma.user.count({ where: live }),
    prisma.user.count({ where: { ...live, resumeFileId: { not: null } } }),
    prisma.user.count({ where: { ...live, resumeFileId: { not: null }, resumeConsentAt: { not: null } } }),
  ]);
  return { members, withResume, withConsent };
}

/** One row of the resume list. No storageKey — nothing outside the bundle builder gets one (see the UploadedFile section above). */
export interface ResumeRosterRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  classification: Classification | "";
  major: string;
  majorOther: string;
  house: string;
  eligible: boolean;
  resumeFileId: string;
  resumeUpdatedAt: Date | null;
  /** Null means no consent on file — shown in the list, excluded from every bundle. */
  resumeConsentAt: Date | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * The filtered list, newest upload first.
 *
 * Deliberately NOT cursor-paginated like getMembersPage, which sits directly
 * above this in spirit. The roster only ever grows and is read a page at a
 * time; this list is bounded twice over — by "has a resume attached" (113 of
 * 270 on the live roster) and by the bundle cap above it — and its entire
 * purpose is to be scanned and multi-selected in one pass. A "Show more"
 * button on the page where someone ticks forty boxes would be a defect, not a
 * safeguard.
 *
 * `User.resumeFileId` is a plain column rather than a relation (see
 * prisma/schema.prisma), so the UploadedFile rows are fetched in a second
 * query and joined in memory. A member whose file row has gone missing
 * entirely still appears, with a zero size — the list's job is to account for
 * every member with a resume on file, the broken ones included.
 */
export async function getResumeRoster(orgId: string, filters: ResumeFilters): Promise<ResumeRosterRow[]> {
  const currentSeason = await getConfigValue(orgId, "SEASON", "");
  const users = await prisma.user.findMany({
    where: resumeWhere(orgId, filters, currentSeason),
    orderBy: [{ resumeUpdatedAt: "desc" }, { lastName: "asc" }, { id: "asc" }],
  });
  if (users.length === 0) return [];

  const fileIds = users.map((u) => u.resumeFileId).filter((id): id is string => Boolean(id));
  const files = await prisma.uploadedFile.findMany({
    where: { orgId, id: { in: fileIds } },
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
  });
  const fileById = new Map(files.map((f) => [f.id, f]));

  return users.map((u) => {
    const m = userToMember(u);
    const file = u.resumeFileId ? fileById.get(u.resumeFileId) : undefined;
    return {
      id: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      classification: m.classification,
      major: m.major,
      majorOther: m.majorOther,
      house: m.house,
      eligible: isEligible(m, currentSeason),
      resumeFileId: u.resumeFileId ?? "",
      resumeUpdatedAt: m.resumeUpdatedAt,
      resumeConsentAt: m.resumeConsentAt,
      originalName: file?.originalName ?? "",
      mimeType: file?.mimeType ?? "",
      sizeBytes: file?.sizeBytes ?? 0,
    };
  });
}

/**
 * WHICH resumes a bundle covers: an explicit set of member ids, or everything
 * matching the filters that were on screen.
 *
 * "all" carries the filters rather than resolving to ids at click time
 * deliberately — it is what the admin actually asked for, it is what reads
 * back out of the AdminLog months later, and it is a few hundred bytes rather
 * than a few hundred ids.
 */
export type ResumeBundleSelection =
  | { kind: "selected"; memberIds: string[] }
  | { kind: "all"; filters: ResumeFilters };

/**
 * The rows a bundle will actually contain: consenting members only, ordered by
 * surname (which is the order a recruiter sorts the extracted folder into
 * anyway, so the manifest and the folder agree).
 *
 * The consent filter is applied HERE, in SQL, not by the caller — it is the
 * rule the whole feature turns on, and leaving a caller to remember it is how
 * a resume nobody consented to share ends up in a recruiter's inbox. A trashed
 * member is excluded by resumeBaseWhere's LIVE for the same reason.
 */
/**
 * One consenting member and the file behind them — the ONLY shape this module
 * hands a `storageKey` to, and only to lib/export/resume-bundle.ts, which
 * streams the bytes and never returns the key to anything else.
 */
export interface ResumeBundleRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  classification: Classification | "";
  major: string;
  majorOther: string;
  house: string;
  nationalMemberReported: boolean | null;
  nationalVerifiedAt: Date | null;
  nationalRevokedAt: Date | null;
  resumeUpdatedAt: Date | null;
  resumeConsentAt: Date | null;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function getResumeBundleRows(
  orgId: string,
  selection: ResumeBundleSelection,
): Promise<ResumeBundleRow[]> {
  const currentSeason = await getConfigValue(orgId, "SEASON", "");
  const where: Prisma.UserWhereInput =
    selection.kind === "all"
      ? resumeWhere(orgId, selection.filters, currentSeason)
      : { ...resumeBaseWhere(orgId), id: { in: selection.memberIds } };

  const users = await prisma.user.findMany({
    where: { AND: [where, { resumeConsentAt: { not: null } }] },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });
  if (users.length === 0) return [];

  const fileIds = users.map((u) => u.resumeFileId).filter((id): id is string => Boolean(id));
  const files = await prisma.uploadedFile.findMany({
    where: { orgId, id: { in: fileIds } },
    select: { id: true, storageKey: true, originalName: true, mimeType: true, sizeBytes: true },
  });
  const fileById = new Map(files.map((f) => [f.id, f]));

  const rows: ResumeBundleRow[] = [];
  for (const u of users) {
    const file = u.resumeFileId ? fileById.get(u.resumeFileId) : undefined;
    // No UploadedFile row at all is a different failure from a missing blob:
    // there is nothing to fetch and nothing to name, so it cannot even become
    // a manifest row. Left out and logged rather than faked.
    if (!file) {
      console.error("resume bundle: member has resumeFileId with no UploadedFile row", {
        memberId: u.id,
        resumeFileId: u.resumeFileId,
      });
      continue;
    }
    const m = userToMember(u);
    rows.push({
      id: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      classification: m.classification,
      major: m.major,
      majorOther: m.majorOther,
      house: m.house,
      nationalMemberReported: m.nationalMemberReported,
      nationalVerifiedAt: m.nationalVerifiedAt,
      nationalRevokedAt: m.nationalRevokedAt,
      resumeUpdatedAt: m.resumeUpdatedAt,
      resumeConsentAt: m.resumeConsentAt,
      storageKey: file.storageKey,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    });
  }
  return rows;
}

/** The RequestClaim scope both halves of a download agree on — see createResumeBundleRequest. */
const RESUME_BUNDLE_SCOPE = "resume_bundle";

/**
 * How long the streaming route will honour a ticket the action minted. Long
 * enough for a slow client to start the download, short enough that a ticket
 * sitting in a browser's history is not a standing entitlement to the bundle.
 */
export const RESUME_BUNDLE_TICKET_TTL_MS = 5 * 60 * 1000;

/** One bundle's scope in a sentence — the AdminLog detail column, and the confirm dialog's description. */
export function describeResumeSelection(selection: ResumeBundleSelection): string {
  if (selection.kind === "selected") return `${selection.memberIds.length} hand-picked member(s)`;
  const f = selection.filters;
  const parts: string[] = [];
  if (f.q?.trim()) parts.push(`search "${f.q.trim()}"`);
  if (f.classification && f.classification !== "all") parts.push(`classification=${f.classification}`);
  if (f.major && f.major !== "all") parts.push(`major=${f.major}`);
  if (f.house && f.house !== "all") parts.push(`house=${f.house}`);
  if (f.eligible && f.eligible !== "all") parts.push(`eligible=${f.eligible}`);
  return parts.length > 0 ? `all matching ${parts.join(", ")}` : "every member with consent on file, no filters";
}

export interface ResumeBundleTicket {
  selection: ResumeBundleSelection;
  /** How many resumes the AdminLog entry was written for. */
  count: number;
}

/**
 * What a claim row carries in its `target`, so the route can reconstruct the
 * exact request the log entry describes without trusting the browser for any
 * of it.
 *
 * The RequestClaim row is never pruned, which makes this the durable record of
 * WHICH members a hand-picked bundle covered — the AdminLog detail deliberately
 * says "12 hand-picked member(s)" rather than pasting twelve ids into a column
 * an admin has to read, and the two rows share a timestamp.
 */
interface ResumeBundleClaim {
  actor: string;
  selection: ResumeBundleSelection;
}

/**
 * Authorize, RECORD, and hand back a ticket the streaming route will accept.
 *
 * `count` comes from the caller rather than being re-queried here: the action
 * has already resolved the rows to check them against the bundle limits, and a
 * second identical query would only create the chance of the logged number and
 * the streamed number disagreeing.
 *
 * The AdminLog entry is written here rather than in the route on purpose: this
 * is where every other admin mutation in this file writes one, inside the same
 * transaction that claims the request token, so "the bundle was logged" and
 * "the bundle was authorized" cannot come apart. The route then streams only
 * what a ticket names, so there is no path to the bytes that skips the log.
 *
 * The selection is stored ON the claim row rather than re-sent by the client,
 * which is what makes the logged filters provably the filters that got
 * streamed — the route reads the scope out of the same row the log entry was
 * written beside, and never trusts a second copy from the browser.
 *
 * Claiming the token is the server-side half of ConfirmDialog's double-submit
 * guard (see claimRequestToken): the dialog mints one token per opening, so a
 * double click writes one log entry and produces one zip, while a deliberate
 * second download gets its own token, its own entry and its own zip — which is
 * correct, because a second copy really did leave the system.
 *
 * The entry is written BEFORE a byte is streamed, so a download that dies
 * halfway still leaves a record. Over-reporting is the safe direction here:
 * the log answering "who asked for what" matters more than it answering "who
 * successfully received it", and a partially delivered zip is still a zip that
 * partially left.
 */
export async function createResumeBundleRequest(
  orgId: string,
  input: { actor: string; requestToken: string; selection: ResumeBundleSelection; count: number },
): Promise<ResumeBundleTicket> {
  const detail = `${input.count} resume(s) — ${describeResumeSelection(input.selection)}`;

  await prisma.$transaction(async (tx) => {
    const claim: ResumeBundleClaim = { actor: normalizeEmail(input.actor), selection: input.selection };
    await claimRequestToken(tx, orgId, RESUME_BUNDLE_SCOPE, input.requestToken, JSON.stringify(claim));
    await logAdminAction(tx, orgId, {
      actor: input.actor,
      action: "download_resume_bundle",
      target: "resumes",
      detail,
    });
  });

  return { selection: input.selection, count: input.count };
}

/**
 * The ticket side of the above: the selection this token was logged for, or
 * null when there is no such claim, it has gone stale, or it belongs to a
 * different actor. A route that gets null must refuse — an unticketed download
 * is an unlogged one.
 *
 * The actor check is what keeps the log honest rather than merely present. Two
 * people can hold files_read; without it, one of them redeeming the other's
 * token would produce a zip whose only record names the wrong person, which is
 * a worse outcome than no record at all.
 */
export async function getResumeBundleTicket(
  orgId: string,
  token: string,
  actor: string,
): Promise<ResumeBundleSelection | null> {
  if (!token) return null;
  const row = await prisma.requestClaim.findUnique({
    where: { orgId_scope_token: { orgId, scope: RESUME_BUNDLE_SCOPE, token } },
    select: { target: true, createdAt: true },
  });
  if (!row?.target) return null;
  if (Date.now() - row.createdAt.getTime() > RESUME_BUNDLE_TICKET_TTL_MS) return null;
  let claim: ResumeBundleClaim;
  try {
    claim = JSON.parse(row.target) as ResumeBundleClaim;
  } catch {
    return null;
  }
  if (claim.actor !== normalizeEmail(actor)) return null;
  return claim.selection ?? null;
}
