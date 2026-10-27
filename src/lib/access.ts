/**
 * What each /admin surface requires, and why a given caller was turned away.
 *
 * This is the ONE table the admin nav and the admin page guards both read. A
 * nav item that leads to a denied page is a bug in its own right, so the nav
 * must not be allowed to drift from the guards: AdminNav filters its links
 * with denialFor(), and every admin page gates itself with guardAdminPage() —
 * both against ADMIN_SURFACES below. Adding a surface means adding one row
 * here, not remembering to edit two lists.
 *
 * denialFor() is deliberately pure — it takes an already-loaded AdminAccess
 * rather than reaching for the session or the database — so the nav can decide
 * eleven links from a single pair of reads, and so the whole matrix is unit
 * testable without Postgres (see access.test.ts).
 *
 * On specificity: a denial names the requirement it missed ("requires the
 * Membership audit permission"), never a generic "admin-only", because the
 * person reading it needs to know what to ask an admin FOR. The one place that
 * detail cannot travel is a Server Component error boundary — see
 * admin/error.tsx for why the guards return a denial instead of throwing one.
 *
 * Everything here is pure and dependency-free on purpose. The guards that
 * actually reach for the session, the roster, and the Config flags live in
 * lib/access-guards.ts, so this policy — the part worth testing exhaustively —
 * can be imported by a unit test, and by lib/permissions.ts, without dragging
 * next-auth in behind it.
 */

import type { Denial, FeatureName, PermissionName, Role } from "./types";

/** Member-facing name for a grant — what the access-denied page tells someone to ask for. Matches the label on the member detail page's Permissions panel. */
export const PERMISSION_LABEL: Record<PermissionName, string> = {
  verifications_write: "Membership audit",
  attendance_write: "Attendance editing",
  points_write: "Point adjustments",
  files_read: "Resume access",
  houses_write: "House scoring",
};

/**
 * Which roles hold each capability OUTRIGHT, with no grant.
 *
 * This is the difference between a capability that is ordinary officer work
 * and one that isn't:
 *
 *   verifications_write  EBOARD and ADMIN. Reviewing a dues receipt is what
 *                        officers do; requiring a grant for it would mean
 *                        granting it to every officer on day one.
 *
 *   attendance_write     ADMIN only. Adding someone to a CLOSED event awards
 *                        points, as does re-pointing or removing a
 *                        registration — it changes the leaderboard after the
 *                        window shut. Keeping EBOARD out by default is the
 *                        entire reason "an officer with read-only attendance
 *                        access" is an expressible state rather than a
 *                        comment: every officer can read the directory, and
 *                        only an admin, or an officer explicitly granted
 *                        this, can change what it says.
 *
 *   points_write         ADMIN only. Adds or revokes a signed point
 *                        adjustment — moving a member up or down the
 *                        leaderboard by fiat, with no attendance behind it.
 *                        Its own domain rather than a reuse of
 *                        attendance_write on purpose: someone trusted to fix
 *                        an attendance typo is not thereby trusted to move
 *                        people on the leaderboard, and a single grant must
 *                        not hand out both.
 *
 *   files_read           ADMIN only. Reads other members' uploaded documents
 *                        in bulk — /admin/resumes builds a zip of every
 *                        consenting member's resume. Pointedly NOT held by
 *                        EBOARD the way verifications_write is: an officer
 *                        opening ONE House screenshot mid-review (see
 *                        repo.canAccessFile, which is a different and much
 *                        narrower rule) is ordinary work; walking off with
 *                        every resume on the roster is not. It exists as a
 *                        grant so the recruiting chair can hold exactly this
 *                        surface without being made an admin.
 *
 *   houses_write         ADMIN only. The write half of /admin/houses: picking
 *                        competition winners, MANUAL House awards, revoking,
 *                        and every (re)calculation. READING the tab is plain
 *                        E-Board level — standings and rosters are officer
 *                        information. Not folded into points_write: moving a
 *                        House is not moving a member, and a House chair can
 *                        be granted this without being able to do the other.
 */
const PERMISSION_ROLES: Record<PermissionName, readonly Role[]> = {
  verifications_write: ["admin", "eboard"],
  attendance_write: ["admin"],
  points_write: ["admin"],
  files_read: ["admin"],
  houses_write: ["admin"],
};

/** True when `role` holds `permission` by virtue of the role alone. The one implementation — lib/permissions.ts defers to it rather than re-deriving a role comparison. */
export function roleHoldsPermission(role: Role, permission: PermissionName): boolean {
  return PERMISSION_ROLES[permission].includes(role);
}

/**
 * What a surface demands. `level` is the role/grant floor; `feature` is an
 * additional org-wide switch that must also be on (see lib/features.ts).
 * Both must pass, and `level` is checked first — someone who lacks access
 * shouldn't learn which features the org has switched off.
 */
export type Requirement =
  | { level: "eboard"; feature?: FeatureName }
  | { level: "admin"; feature?: FeatureName }
  | { level: "permission"; permission: PermissionName; feature?: FeatureName };

/** Everything denialFor() needs, loaded once per request by loadAdminAccess(). */
export interface AdminAccess {
  /** Re-read from the roster, never taken from the JWT — see lib/session.ts requireAdmin for why. */
  role: Role;
  permissions: PermissionName[];
  features: Record<FeatureName, boolean>;
}

/**
 * null when the caller may proceed, otherwise WHY not.
 *
 * A "permission" requirement is satisfied either by holding the grant or by a
 * role that holds that capability outright — see PERMISSION_ROLES, which is
 * deliberately NOT "admin and eboard pass everything": attendance_write is
 * ADMIN-only precisely so an officer can have read-without-write.
 */
export function denialFor(access: AdminAccess, requirement: Requirement): Denial | null {
  const isAdminRole = access.role === "admin";
  const isEboardRole = isAdminRole || access.role === "eboard";

  switch (requirement.level) {
    case "admin":
      if (!isAdminRole) return { kind: "admin" };
      break;
    case "eboard":
      if (!isEboardRole) return { kind: "eboard" };
      break;
    case "permission":
      if (
        !roleHoldsPermission(access.role, requirement.permission) &&
        !access.permissions.includes(requirement.permission)
      ) {
        return { kind: "permission", permission: requirement.permission };
      }
      break;
  }

  if (requirement.feature && !access.features[requirement.feature]) {
    return { kind: "feature", feature: requirement.feature };
  }
  return null;
}

export function isAllowed(access: AdminAccess, requirement: Requirement): boolean {
  return denialFor(access, requirement) === null;
}

/**
 * The copy the access-denied page renders. One heading for every case — being
 * turned away is a normal, expected outcome, not an incident, and a different
 * headline per cause would make it read like one. The body carries the detail.
 */
export function denialCopy(denial: Denial): { heading: string; body: string } {
  const heading = "You don't have access to this page";
  switch (denial.kind) {
    case "permission":
      return {
        heading,
        body: `This page requires the ${PERMISSION_LABEL[denial.permission]} permission. Ask an admin to grant it.`,
      };
    case "admin":
      return { heading, body: "This page is admin-only. If you need access, ask a current admin to grant it." };
    case "eboard":
      return { heading, body: "This page is E-Board only. If you need access, ask a current admin to grant it." };
    case "feature":
      return denial.feature === "exports"
        ? { heading, body: "Exports are turned off right now. An admin can turn them back on from Settings." }
        : { heading, body: "This page is turned off right now. An admin can turn it back on from Settings." };
  }
}

/** Same text, for the JSON body of a 403 from an API route — see lib/api.ts withApiErrors, which never renders HTML. */
export function denialMessage(denial: Denial): string {
  return denialCopy(denial).body;
}

// ---------------------------------------------------------------------------
// The surface table
// ---------------------------------------------------------------------------

/**
 * The resume bundle's requirement, named once.
 *
 * Unlike every other surface, this one is enforced in three places — the page
 * guard, the server action that records the download, and the route that
 * streams the bytes — and a bundle of members' personal documents is the last
 * thing that should be protected by three hand-copied object literals. The
 * ADMIN_SURFACES row below points at this same constant.
 */
export const RESUME_BUNDLE_ACCESS = {
  level: "permission",
  permission: "files_read",
  feature: "exports",
} as const satisfies Requirement;

/**
 * Every /admin surface that appears in the cross-nav, in nav order, with the
 * requirement its page enforces. `/admin/exports` keeps its row while
 * EXPORTS_ENABLED is false — the feature flag hides it, so flipping the flag
 * in Settings restores the nav item and the page together with no deploy.
 */
export const ADMIN_SURFACES = [
  { href: "/admin", label: "Events", requires: { level: "eboard" } },
  { href: "/admin/members", label: "Member Directory", requires: { level: "admin" } },
  {
    href: "/admin/verifications",
    label: "Membership audit",
    requires: { level: "permission", permission: "verifications_write" },
  },
  { href: "/admin/leaderboard", label: "E-Board leaderboard", requires: { level: "eboard" } },
  { href: "/admin/attendance", label: "Attendance", requires: { level: "eboard" } },
  { href: "/admin/groups", label: "NSBE Week groups", requires: { level: "admin" } },
  { href: "/admin/awards", label: "Bonus awards", requires: { level: "admin" } },
  { href: "/admin/houses", label: "Houses", requires: { level: "eboard" } },
  { href: "/admin/seasons", label: "Seasons", requires: { level: "eboard" } },
  { href: "/admin/exports", label: "Exports", requires: { level: "eboard", feature: "exports" } },
  { href: "/admin/resumes", label: "Resume bundle", requires: RESUME_BUNDLE_ACCESS },
  { href: "/admin/settings", label: "Settings", requires: { level: "admin" } },
  { href: "/admin/qr", label: "QR code", requires: { level: "eboard" } },
  { href: "/admin/join-codes", label: "Join codes", requires: { level: "admin" } },
  { href: "/admin/trash", label: "Trash", requires: { level: "admin" } },
] as const satisfies readonly { href: string; label: string; requires: Requirement }[];

export type AdminHref = (typeof ADMIN_SURFACES)[number]["href"];

export interface AdminNavLink {
  href: string;
  label: string;
}

/** The nav items this caller may actually reach — the primary control. The access-denied page is only the safety net behind it. */
export function visibleAdminNav(access: AdminAccess): AdminNavLink[] {
  return ADMIN_SURFACES.filter((s) => isAllowed(access, s.requires)).map(({ href, label }) => ({ href, label }));
}

/** The refusal half of lib/access-guards.ts guardAdminPage's result — kept here, with the policy, so admin/_components/AccessDenied.tsx can type its props without importing the auth-bound guards. */
export interface AdminPageDenied {
  ok: false;
  denial: Denial;
  /** False when the caller can't reach /admin either — the access-denied page then omits its "Back to admin" action rather than offering a link into a second denial. */
  canUseAdminHome: boolean;
}
