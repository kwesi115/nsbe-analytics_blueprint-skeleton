"use client";

import { grantPermissionAction, revokePermissionAction, type MemberActionState } from "@/app/(member)/admin/members/actions";
import ActionButton from "@/components/ui/ActionButton";
import Badge from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import type { PermissionName } from "@/lib/types";

const LABEL: Record<PermissionName, string> = {
  verifications_write: "Verify dues/national/House (/admin/verifications)",
  attendance_write: "Add, remove & re-point attendance (/admin/attendance)",
  points_write: "Adjust points (/admin/members)",
  files_read: "Download member resumes in bulk (/admin/resumes)",
  houses_write: "Run House scoring (/admin/houses)",
};

/** What each grant is FOR, in the terms an admin decides by — the attendance one hands out the ability to change the leaderboard after an event has closed, and should read that way. */
const DESCRIPTION: Record<PermissionName, string> = {
  verifications_write: "Review dues receipts, national membership, and House test screenshots.",
  attendance_write:
    "Award points after the fact — add a member who missed check-in on a closed event, correct a point value, or remove a registration. E-Board officers do NOT have this by default.",
  points_write: "Add or revoke signed point adjustments that move a member on the leaderboard.",
  files_read:
    "Build and download a zip of every consenting member's resume, with a manifest. E-Board officers do NOT have this by default — a bundle of personal documents leaves the system the moment it is downloaded.",
  houses_write:
    "Pick House competition winners, add or revoke manual House points, and recalculate House scoring. Never touches individual member points. E-Board officers can view the Houses tab but do NOT have this by default.",
};

const INITIAL_STATE: MemberActionState = { error: null };

/** ADMIN-only escape valve for "this one member needs exactly one EBOARD-gated surface" without promoting their role — see lib/permissions.ts. Revoking takes effect on that member's very next request, not their next sign-in. */
export default function PermissionsPanel({ email, granted }: { email: string; granted: PermissionName[] }) {
  const { show } = useToast();
  const has = (p: PermissionName) => granted.includes(p);

  // points_write is deliberately not offered: its only surfaces (the Member
  // Directory and a member's page) are ADMIN-only pages, so a grant to anyone
  // else would enable nothing they could reach. It exists as its own domain so
  // the adjustment actions check the right capability; see lib/access.ts.
  const permissions: PermissionName[] = ["verifications_write", "attendance_write", "files_read", "houses_write"];

  return (
    <div className="flex flex-col gap-2">
      {permissions.map((p) => (
        <div key={p} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={has(p) ? "signal" : "muted"}>{has(p) ? "Granted" : "Not granted"}</Badge>
            <span className="text-sm text-foreground">{LABEL[p]}</span>
            {/* Dispatched as a form submit (see ui/ActionButton.tsx), so the
                button is genuinely disabled while the grant is in flight —
                clicking twice used to grant and then immediately revoke. */}
            <ActionButton<MemberActionState>
              action={has(p) ? revokePermissionAction : grantPermissionAction}
              initialState={INITIAL_STATE}
              payload={{ email, permission: p }}
              label={has(p) ? "Revoke" : "Grant"}
              variant="ghost"
              // The form wrapper is display:contents, so the button itself is
              // still the flex item this ml-auto pushes to the right.
              className="ml-auto"
              onSuccess={() =>
                show(has(p) ? "Revoked — takes effect on their next request" : `Granted ${LABEL[p]}`)
              }
              onError={(message) => show(message, "error")}
            />
          </div>
          <p className="text-xs text-muted">{DESCRIPTION[p]}</p>
        </div>
      ))}
    </div>
  );
}
