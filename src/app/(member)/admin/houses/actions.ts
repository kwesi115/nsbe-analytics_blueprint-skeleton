"use server";

import { revalidatePath } from "next/cache";
import { requireAccess } from "@/lib/access-guards";
import { AppError } from "@/lib/errors";
import {
  calculateHouseMonth,
  createManualHouseAward,
  previewHouseMonth,
  processEventHouseScoring,
  recalculateAllHouseScoring,
  revokeHouseAward,
  setCompetitionWinners,
  type HouseAwardChange,
  type HouseMonthPreview,
} from "@/lib/house-repo";

/**
 * Every write on /admin/houses requires houses_write (ADMIN outright, or
 * granted — see lib/access.ts). Reading the tab is E-Board level; the page
 * guard enforces that, these re-check the write half themselves.
 */
const HOUSES_WRITE = { level: "permission", permission: "houses_write" } as const;

export interface HouseActionState {
  error: string | null;
  /** A one-line summary of what changed, for the toast. */
  message?: string;
}

function refresh() {
  revalidatePath("/admin/houses");
  revalidatePath("/admin/seasons");
}

function describe(changes: HouseAwardChange[]): string {
  if (changes.length === 0) return "No change — the awards already matched.";
  return changes.map((c) => `${c.house} ${c.category.replaceAll("_", " ").toLowerCase()}: ${c.from ?? "new"} → ${c.to}`).join("; ");
}

async function run(work: () => Promise<string>): Promise<HouseActionState> {
  try {
    const message = await work();
    refresh();
    return { error: null, message };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export async function processEventHouseScoringAction(_prev: HouseActionState, formData: FormData): Promise<HouseActionState> {
  return run(async () => {
    const session = await requireAccess(HOUSES_WRITE);
    const result = await processEventHouseScoring(session.user.orgId, String(formData.get("eventId") ?? ""), {
      actor: session.user.email,
      trigger: "manual",
    });
    return describe(result.changes);
  });
}

export async function setCompetitionWinnersAction(_prev: HouseActionState, formData: FormData): Promise<HouseActionState> {
  return run(async () => {
    const session = await requireAccess(HOUSES_WRITE);
    const winners = formData.getAll("winners").map(String);
    const result = await setCompetitionWinners(session.user.orgId, String(formData.get("eventId") ?? ""), winners, session.user.email);
    revalidatePath(`/admin/events/${result.eventId}/edit`);
    return describe(result.changes);
  });
}

export async function createManualHouseAwardAction(_prev: HouseActionState, formData: FormData): Promise<HouseActionState> {
  return run(async () => {
    const session = await requireAccess(HOUSES_WRITE);
    await createManualHouseAward({
      orgId: session.user.orgId,
      house: String(formData.get("house") ?? ""),
      points: Number(formData.get("points") ?? 0),
      reason: String(formData.get("reason") ?? ""),
      actor: session.user.email,
    });
    return "Manual House award added.";
  });
}

export async function revokeHouseAwardAction(_prev: HouseActionState, formData: FormData): Promise<HouseActionState> {
  return run(async () => {
    const session = await requireAccess(HOUSES_WRITE);
    await revokeHouseAward(session.user.orgId, String(formData.get("id") ?? ""), String(formData.get("reason") ?? ""), session.user.email);
    return "Award revoked.";
  });
}

export async function calculateHouseMonthAction(_prev: HouseActionState, formData: FormData): Promise<HouseActionState> {
  return run(async () => {
    const session = await requireAccess(HOUSES_WRITE);
    const result = await calculateHouseMonth(session.user.orgId, String(formData.get("month") ?? ""), session.user.email);
    return describe(result.changes);
  });
}

export async function recalculateAllHouseScoringAction(): Promise<HouseActionState> {
  return run(async () => {
    const session = await requireAccess(HOUSES_WRITE);
    const r = await recalculateAllHouseScoring(session.user.orgId, session.user.email);
    const moved = [...r.events.flatMap((e) => e.changes), ...r.months.flatMap((m) => m.changes)];
    const failed = r.failures.length ? ` ${r.failures.length} failed: ${r.failures.map((f) => f.error).join("; ")}` : "";
    return `${r.events.length} event(s) and ${r.months.length} month(s) recalculated — ${moved.length} award(s) changed.${failed}`;
  });
}

export interface HouseMonthPreviewResult {
  error: string | null;
  preview: HouseMonthPreview | null;
}

/** Read-only — the diff shown before (re)calculating a month. Read access is enough. */
export async function previewHouseMonthAction(month: string): Promise<HouseMonthPreviewResult> {
  try {
    const session = await requireAccess({ level: "eboard" });
    return { error: null, preview: await previewHouseMonth(session.user.orgId, month) };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message, preview: null };
    throw err;
  }
}
