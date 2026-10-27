"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { clearEventCodeLock } from "@/lib/rate-limit";
import {
  awardGameBonus,
  cancelEvent,
  closeEventNow,
  copyFormFields,
  createEvent,
  extendEvent,
  logSystemAdminEvent,
  openEventNow,
  reopenEvent,
  saveFormFields,
  updateEvent,
  type FormFieldInput,
} from "@/lib/repo";
import { requireEboard } from "@/lib/session";
import type { Audience } from "@/lib/types";

export interface EventFormState {
  error: string | null;
}

function readEventFields(formData: FormData) {
  const pointsRaw = String(formData.get("points") ?? "").trim();
  const durationRaw = String(formData.get("durationMinutes") ?? "").trim();
  const groupIdRaw = String(formData.get("groupId") ?? "").trim();
  return {
    name: String(formData.get("name") ?? "").trim(),
    categoryId: String(formData.get("categoryId") ?? "").trim(),
    groupId: groupIdRaw === "" ? null : groupIdRaw,
    slug: String(formData.get("slug") ?? "").trim(),
    date: formData.get("date") ? new Date(String(formData.get("date"))) : null,
    location: String(formData.get("location") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    points: pointsRaw === "" ? null : Number(pointsRaw),
    durationMinutes: durationRaw === "" ? null : Number(durationRaw),
    audience: String(formData.get("audience") ?? "all") as Audience,
    house: {
      countsForShowUp: formData.get("countsForShowUp") === "on",
      countsForRepYourHouse: formData.get("countsForRepYourHouse") === "on",
      countsForMonthlyHouse: formData.get("countsForMonthlyHouse") === "on",
      isHouseCompetition: formData.get("isHouseCompetition") === "on",
    },
  };
}

export async function createEventAction(_prevState: EventFormState, formData: FormData): Promise<EventFormState> {
  const session = await requireEboard();
  const fields = readEventFields(formData);
  if (!fields.name || !fields.categoryId) {
    return { error: "Name and category are required." };
  }

  let eventId: string;
  try {
    const event = await createEvent({ orgId: session.user.orgId, ...fields, createdBy: session.user.email });
    eventId = event.eventId;
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }

  revalidatePath("/admin");
  redirect(`/admin/events/${eventId}/questions`);
}

export async function updateEventAction(
  eventId: string,
  _prevState: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const session = await requireEboard();
  const fields = readEventFields(formData);
  if (!fields.name || !fields.categoryId) {
    return { error: "Name and category are required." };
  }

  try {
    await updateEvent({ orgId: session.user.orgId, eventId, ...fields, actor: session.user.email });
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }

  revalidatePath("/admin");
  redirect("/admin");
}

export interface ActionResult {
  error: string | null;
}

/**
 * The event lifecycle, as `(prevState, formData)` actions.
 *
 * Every one of these is dispatched by a form submit — EventsBoard wraps each
 * control in ActionButton or ConfirmDialog — so React owns the transition and
 * reports a real `pending`. That matters most for "+10 min": the old
 * onClick+startTransition button reported pending correctly but only after a
 * re-render, so two clicks inside one frame both reached the server and the
 * event quietly got +20.
 */
function eventIdFrom(formData: FormData): string {
  return String(formData.get("eventId") ?? "");
}

/** Minutes from a <select>/hidden input, falling back to the caller's default rather than trusting a blank or a negative. */
function minutesFrom(formData: FormData, field: string, fallback: number): number {
  const raw = Number(formData.get(field));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export async function openEventAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireEboard();
  try {
    await openEventNow({
      orgId: session.user.orgId,
      eventId: eventIdFrom(formData),
      openedBy: session.user.email,
      durationMinutes: minutesFrom(formData, "durationMinutes", 30),
    });
    revalidatePath("/admin");
    return { error: null };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export async function extendEventAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireEboard();
  try {
    await extendEvent({
      orgId: session.user.orgId,
      eventId: eventIdFrom(formData),
      extraMinutes: minutesFrom(formData, "extraMinutes", 10),
      actor: session.user.email,
    });
    revalidatePath("/admin");
    return { error: null };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export async function closeEventAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireEboard();
  try {
    await closeEventNow({ orgId: session.user.orgId, eventId: eventIdFrom(formData), actor: session.user.email });
    revalidatePath("/admin");
    return { error: null };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export async function cancelEventAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireEboard();
  try {
    await cancelEvent(session.user.orgId, eventIdFrom(formData), session.user.email);
    revalidatePath("/admin");
    return { error: null };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export async function reopenEventAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireEboard();
  try {
    await reopenEvent({
      orgId: session.user.orgId,
      eventId: eventIdFrom(formData),
      reopenedBy: session.user.email,
      durationMinutes: minutesFrom(formData, "durationMinutes", 30),
    });
    revalidatePath("/admin");
    return { error: null };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export interface SaveFormResult {
  error: string | null;
  fields?: FormFieldInput[];
}

export async function saveFormAction(eventId: string, fields: FormFieldInput[]): Promise<SaveFormResult> {
  const session = await requireEboard();
  try {
    const saved = await saveFormFields({ orgId: session.user.orgId, eventId, fields, actor: session.user.email });
    revalidatePath(`/admin/events/${eventId}/questions`);
    return { error: null, fields: saved };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}

export interface AwardGameBonusResult {
  error: string | null;
  awarded: string[];
  skipped: string[];
}

/**
 * +1 per member per event, capped by PointAward's own unique constraint — see
 * lib/repo.ts awardGameBonus. Only registrants for the event should be offered
 * as choices by the caller.
 *
 * Form-dispatched like every other mutation here, so the selection, the point
 * value and the reason are read from the submission. A repeat submission is
 * capped by that unique constraint rather than double-awarding, which is why
 * this one needs no request token.
 */
export async function awardGameBonusAction(_prev: AwardGameBonusResult, formData: FormData): Promise<AwardGameBonusResult> {
  const session = await requireEboard();
  const eventId = String(formData.get("eventId") ?? "");
  const emails = formData.getAll("emails").map((e) => String(e));
  const reason = String(formData.get("reason") ?? "");
  const pointsRaw = Number(formData.get("points"));
  const points = Number.isFinite(pointsRaw) ? pointsRaw : 1;
  try {
    const result = await awardGameBonus(session.user.orgId, eventId, emails, points, reason, session.user.email);
    revalidatePath(`/admin/events/${eventId}/responses`);
    revalidatePath("/admin/awards");
    return { error: null, ...result };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message, awarded: [], skipped: [] };
    throw err;
  }
}

/** The escape hatch for a per-event check-in code brute-force lock (see lib/rate-limit.ts) — a legitimate room full of people fat-fingering the code shouldn't have to wait out the full 5 minutes. */
export async function clearEventCodeLockAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireEboard();
  const eventId = eventIdFrom(formData);
  clearEventCodeLock(eventId);
  await logSystemAdminEvent(session.user.orgId, {
    actor: session.user.email,
    action: "code_brute_force_lock_cleared",
    target: eventId,
  });
  revalidatePath("/admin");
  return { error: null };
}

export async function copyFormAction(eventId: string, fromEventId: string): Promise<SaveFormResult> {
  const session = await requireEboard();
  try {
    const copied = await copyFormFields(session.user.orgId, fromEventId, eventId, session.user.email);
    revalidatePath(`/admin/events/${eventId}/questions`);
    return { error: null, fields: copied };
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
}
