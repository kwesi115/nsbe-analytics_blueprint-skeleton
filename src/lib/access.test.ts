/**
 * The access matrix — pure, so the whole thing runs without Postgres or a
 * session. denialFor() is the single decision both the admin nav and every
 * admin page guard go through (see lib/access.ts), which is what these tests
 * are really pinning down: the nav must not advertise a surface the guard
 * would refuse, and the guard must not refuse one the nav shows.
 */

import { describe, expect, it } from "vitest";
import {
  ADMIN_SURFACES,
  type AdminAccess,
  denialCopy,
  denialFor,
  denialMessage,
  isAllowed,
  PERMISSION_LABEL,
  RESUME_BUNDLE_ACCESS,
  visibleAdminNav,
} from "./access";
import type { Role } from "./types";

function accessFor(
  role: Role,
  opts: { permissions?: AdminAccess["permissions"]; exports?: boolean } = {},
): AdminAccess {
  return {
    role,
    permissions: opts.permissions ?? [],
    features: { exports: opts.exports ?? false },
  };
}

const hrefs = (access: AdminAccess) => visibleAdminNav(access).map((l) => l.href);

describe("denialFor — role levels", () => {
  it("lets an ADMIN through every level", () => {
    const admin = accessFor("admin");
    expect(denialFor(admin, { level: "admin" })).toBeNull();
    expect(denialFor(admin, { level: "eboard" })).toBeNull();
    expect(denialFor(admin, { level: "permission", permission: "verifications_write" })).toBeNull();
  });

  it("turns an EBOARD away from an ADMIN-only surface, naming it as admin-only", () => {
    expect(denialFor(accessFor("eboard"), { level: "admin" })).toEqual({ kind: "admin" });
  });

  // files_read is deliberately NOT one of the capabilities a role carries for
  // free — see PERMISSION_ROLES. An officer gets it by grant or not at all.
  it("turns a GENERAL member and an ungranted EBOARD officer away from files_read alike", () => {
    for (const role of ["general", "eboard"] as const) {
      expect(denialFor(accessFor(role, { exports: true }), RESUME_BUNDLE_ACCESS)).toEqual({
        kind: "permission",
        permission: "files_read",
      });
    }
    expect(denialFor(accessFor("admin", { exports: true }), RESUME_BUNDLE_ACCESS)).toBeNull();
    expect(
      denialFor(accessFor("eboard", { exports: true, permissions: ["files_read"] }), RESUME_BUNDLE_ACCESS),
    ).toBeNull();
  });

  // The role check answers first, so an ungranted officer never learns whether
  // the org has exports switched on.
  it("reports the missing grant rather than the flag when a caller fails both", () => {
    expect(denialFor(accessFor("eboard", { exports: false }), RESUME_BUNDLE_ACCESS)).toEqual({
      kind: "permission",
      permission: "files_read",
    });
  });

  it("lets an EBOARD through eboard-level and grant-level surfaces without holding the grant", () => {
    const eboard = accessFor("eboard");
    expect(denialFor(eboard, { level: "eboard" })).toBeNull();
    expect(denialFor(eboard, { level: "permission", permission: "verifications_write" })).toBeNull();
  });

  it("turns a GENERAL member away from eboard-level surfaces", () => {
    expect(denialFor(accessFor("general"), { level: "eboard" })).toEqual({ kind: "eboard" });
    expect(denialFor(accessFor("general"), { level: "admin" })).toEqual({ kind: "admin" });
  });

  it("lets a GENERAL member through exactly the surface they hold a grant for", () => {
    const granted = accessFor("general", { permissions: ["verifications_write"] });
    expect(denialFor(granted, { level: "permission", permission: "verifications_write" })).toBeNull();
    expect(denialFor(granted, { level: "admin" })).toEqual({ kind: "admin" });
  });

  it("names the missing grant when a GENERAL member lacks it", () => {
    expect(denialFor(accessFor("general"), { level: "permission", permission: "verifications_write" })).toEqual({
      kind: "permission",
      permission: "verifications_write",
    });
  });

  it("turns a GUEST away from everything", () => {
    const guest = accessFor("guest", { exports: true });
    for (const surface of ADMIN_SURFACES) {
      expect(isAllowed(guest, surface.requires)).toBe(false);
    }
  });
});

describe("denialFor — feature flags", () => {
  it("denies a flagged surface when the flag is off, even for an ADMIN", () => {
    expect(denialFor(accessFor("admin", { exports: false }), { level: "eboard", feature: "exports" })).toEqual({
      kind: "feature",
      feature: "exports",
    });
  });

  it("allows it once the flag is on", () => {
    expect(denialFor(accessFor("admin", { exports: true }), { level: "eboard", feature: "exports" })).toBeNull();
  });

  // Otherwise a GENERAL member probing /admin/exports learns which features the
  // org has switched off — the role check has to answer first.
  it("reports the role failure, not the flag, when the caller fails both", () => {
    expect(denialFor(accessFor("general", { exports: false }), { level: "eboard", feature: "exports" })).toEqual({
      kind: "eboard",
    });
  });
});

describe("visibleAdminNav — the primary control", () => {
  it("shows an ADMIN everything except the two surfaces the flagged-off Exports switch gates", () => {
    const admin = hrefs(accessFor("admin"));
    expect(admin).not.toContain("/admin/exports");
    expect(admin).not.toContain("/admin/resumes");
    expect(admin.length).toBe(ADMIN_SURFACES.length - 2);
    // Both come back together, because both are gated on the same flag.
    expect(hrefs(accessFor("admin", { exports: true })).length).toBe(ADMIN_SURFACES.length);
  });

  // The nav bug this whole change exists to fix: an EBOARD officer was being
  // shown Members / Groups / Awards / Settings / Join codes and then refused.
  it("hides every ADMIN-only item from an EBOARD officer", () => {
    const eboard = hrefs(accessFor("eboard"));
    for (const href of ["/admin/members", "/admin/groups", "/admin/awards", "/admin/settings", "/admin/join-codes"]) {
      expect(eboard).not.toContain(href);
    }
    expect(eboard).toEqual(["/admin", "/admin/verifications", "/admin/leaderboard", "/admin/attendance", "/admin/houses", "/admin/seasons", "/admin/qr"]);
  });

  it("shows a GENERAL member with one grant only that item", () => {
    expect(hrefs(accessFor("general", { permissions: ["verifications_write"] }))).toEqual(["/admin/verifications"]);
  });

  /**
   * The resume bundle is the one surface where a grant to an EBOARD officer is
   * the point: the recruiting chair needs it and nobody else does. So it must
   * be invisible to an officer who does not hold it, and visible to one who
   * does — unlike /admin/verifications, which every officer holds by role.
   */
  it("hides the resume bundle from an EBOARD officer without the grant, and shows it with one", () => {
    expect(hrefs(accessFor("eboard", { exports: true }))).not.toContain("/admin/resumes");
    expect(hrefs(accessFor("eboard", { exports: true, permissions: ["files_read"] }))).toContain("/admin/resumes");
  });

  it("still hides the resume bundle from a granted officer while exports are switched off", () => {
    expect(hrefs(accessFor("eboard", { exports: false, permissions: ["files_read"] }))).not.toContain(
      "/admin/resumes",
    );
  });

  it("shows a GENERAL member with no grant nothing at all", () => {
    expect(hrefs(accessFor("general"))).toEqual([]);
  });

  it("restores the Exports item as soon as the flag is on", () => {
    expect(hrefs(accessFor("eboard", { exports: false }))).not.toContain("/admin/exports");
    expect(hrefs(accessFor("eboard", { exports: true }))).toContain("/admin/exports");
  });

  // The safety net and the primary control have to agree: anything the nav
  // offers must survive the same check the page runs.
  it("never offers a link the page guard would refuse", () => {
    const cases: AdminAccess[] = [
      accessFor("admin", { exports: true }),
      accessFor("admin"),
      accessFor("eboard", { exports: true }),
      accessFor("eboard"),
      accessFor("general", { permissions: ["verifications_write"] }),
      accessFor("general"),
      accessFor("eboard", { exports: true, permissions: ["files_read"] }),
      accessFor("guest", { exports: true }),
    ];
    for (const access of cases) {
      for (const href of hrefs(access)) {
        const surface = ADMIN_SURFACES.find((s) => s.href === href)!;
        expect(denialFor(access, surface.requires)).toBeNull();
      }
    }
  });
});

describe("denialCopy — calm, and specific where it can be", () => {
  it("names the permission rather than saying admin-only", () => {
    const { body } = denialCopy({ kind: "permission", permission: "verifications_write" });
    expect(body).toContain(PERMISSION_LABEL.verifications_write);
    expect(body).toBe("This page requires the Membership audit permission. Ask an admin to grant it.");
  });

  it("says admin-only for an ADMIN-only surface", () => {
    expect(denialCopy({ kind: "admin" }).body).toBe(
      "This page is admin-only. If you need access, ask a current admin to grant it.",
    );
  });

  it("explains a flagged-off surface as switched off, not as a permission problem", () => {
    const { body } = denialCopy({ kind: "feature", feature: "exports" });
    expect(body).toMatch(/turned off/i);
    expect(body).not.toMatch(/permission/i);
  });

  it("uses one steady heading for every cause", () => {
    const headings = [
      denialCopy({ kind: "admin" }),
      denialCopy({ kind: "eboard" }),
      denialCopy({ kind: "permission", permission: "verifications_write" }),
      denialCopy({ kind: "feature", feature: "exports" }),
    ].map((c) => c.heading);
    expect(new Set(headings).size).toBe(1);
    expect(headings[0]).toBe("You don't have access to this page");
  });

  // This is an expected outcome, not a security incident, and the words must
  // not imply one.
  it("never reads like an alarm", () => {
    for (const denial of [
      { kind: "admin" },
      { kind: "eboard" },
      { kind: "permission", permission: "verifications_write" },
      { kind: "feature", feature: "exports" },
    ] as const) {
      const { heading, body } = denialCopy(denial);
      expect(`${heading} ${body}`).not.toMatch(/denied|unauthorized|forbidden|violation|blocked|403/i);
    }
  });

  it("denialMessage is the body, so an API 403 and the page say the same thing", () => {
    expect(denialMessage({ kind: "admin" })).toBe(denialCopy({ kind: "admin" }).body);
  });
});
