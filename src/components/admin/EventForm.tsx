"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { EventFormState } from "@/app/(member)/admin/events/actions";
import Button from "@/components/ui/Button";
import Field, { inputClass, selectClass, textareaClass } from "@/components/ui/Field";
import type { Audience, Event, EventCategory, EventGroup } from "@/lib/types";

const INITIAL_STATE: EventFormState = { error: null };

function toDateInputValue(d: Date | null): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

export default function EventForm({
  action,
  event,
  categories,
  groups,
  submitLabel,
  defaultDurationMinutes,
  winnerPicker,
}: {
  action: (prevState: EventFormState, formData: FormData) => Promise<EventFormState>;
  event?: Event;
  categories: EventCategory[];
  groups: EventGroup[];
  submitLabel: string;
  /** Config.DEFAULT_EVENT_DURATION — used only when creating a new event (an existing one keeps its own stored value). */
  defaultDurationMinutes: number;
  /** The competition winner picker (edit page only) — its own form, so it renders after this one, revealed by the House competition box. */
  winnerPicker?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const [categoryId, setCategoryId] = useState(event?.categoryId ?? "");
  const inheritedPoints = categoryById.get(categoryId)?.memberPoints;

  const [audience, setAudience] = useState<Audience>(event?.audience ?? "all");
  const [isCompetition, setIsCompetition] = useState(event?.house?.isHouseCompetition ?? false);
  const [audienceTouched, setAudienceTouched] = useState(false);

  // Only auto-defaults on a brand-new event (never clobbers an existing
  // event's saved audience while editing) and only until the admin has
  // manually picked something themselves.
  function handleCategoryChange(newCategoryId: string) {
    setCategoryId(newCategoryId);
    if (!event && !audienceTouched) {
      setAudience(categoryById.get(newCategoryId)?.audience ?? "all");
    }
  }

  return (
    <>
    <form action={formAction} className="flex flex-col gap-5">
      <Field label="Name" required>
        {(id) => <input id={id} name="name" required defaultValue={event?.name} className={inputClass} />}
      </Field>

      <Field label="Slug" help="Used for export sheet/file names, e.g. sept-gbm-2026. Auto-generated from the name if left blank.">
        {(id) => <input id={id} name="slug" defaultValue={event?.slug} placeholder="auto-generated" className={inputClass} />}
      </Field>

      <Field label="Category" required help="Determines the default point value, unless overridden below. Managed at /admin/settings/categories.">
        {(id) => (
          <select
            id={id}
            name="categoryId"
            required
            value={categoryId}
            onChange={(e) => handleCategoryChange(e.target.value)}
            className={selectClass}
          >
            <option value="" disabled>
              Select a category…
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.shortName}) — {c.memberPoints} pts
              </option>
            ))}
          </select>
        )}
      </Field>

      {groups.length > 0 ? (
        <Field label="NSBE Week / event group" help="Assigns this event to a group with its own completion bonus (see /admin/groups).">
          {(id) => (
            <select id={id} name="groupId" defaultValue={event?.groupId ?? ""} className={selectClass}>
              <option value="">None</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Audience" help="EBOARD_ONLY events are hidden from the member feed and 403 on direct URL for anyone else.">
          {(id) => (
            <select
              id={id}
              name="audience"
              value={audience}
              onChange={(e) => {
                setAudience(e.target.value as Audience);
                setAudienceTouched(true);
              }}
              className={selectClass}
            >
              <option value="all">All members</option>
              <option value="eboard_only">E-Board only</option>
            </select>
          )}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Date">
          {(id) => <input id={id} type="date" name="date" defaultValue={toDateInputValue(event?.date ?? null)} className={inputClass} />}
        </Field>
        <Field
          label="Points override"
          help={inheritedPoints !== undefined ? `Blank uses the category default (${inheritedPoints}).` : "Blank uses the category default."}
        >
          {(id) => (
            <input
              id={id}
              type="number"
              name="points"
              defaultValue={event?.points ?? ""}
              placeholder={inheritedPoints !== undefined ? String(inheritedPoints) : "0"}
              className={inputClass}
            />
          )}
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium text-foreground">House Scoring</legend>
        <p className="text-xs text-muted">
          A separate track — none of these change any member&apos;s individual points. Pick any combination. Attendance
          counts verified General members only.
        </p>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" name="countsForShowUp" defaultChecked={event?.house?.countsForShowUp ?? false} className="mt-1" />
          <span>
            <strong>Show Up</strong> — each House earns 1 point at 50% attendance, 2 at 75%.
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" name="countsForRepYourHouse" defaultChecked={event?.house?.countsForRepYourHouse ?? false} className="mt-1" />
          <span>
            <strong>Rep Your House</strong> — the House with the highest attendance percentage earns 1 point (ties all earn it).
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" name="countsForMonthlyHouse" defaultChecked={event?.house?.countsForMonthlyHouse ?? false} className="mt-1" />
          <span>
            <strong>Counts toward Own the Month</strong> — included in each House&apos;s monthly average attendance.
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="isHouseCompetition"
            checked={isCompetition}
            onChange={(e) => setIsCompetition(e.target.checked)}
            className="mt-1"
          />
          <span>
            <strong>House competition</strong> — an admin picks the winning House(s) after the event closes; 1 point each.
          </span>
        </label>
        {isCompetition && !winnerPicker ? (
          <p className="text-xs text-muted">Save the event, then pick winners here or on the Houses tab once it closes.</p>
        ) : null}
      </fieldset>

      <Field label="Location">
        {(id) => <input id={id} name="location" defaultValue={event?.location} className={inputClass} />}
      </Field>

      <Field label="Description">
        {(id) => <textarea id={id} name="description" defaultValue={event?.description} className={textareaClass} />}
      </Field>

      <Field label="Default open duration (minutes)" help="Used when you click Open now — you can still pick a different duration then. Chapter default is set in Settings.">
        {(id) => (
          <input
            id={id}
            type="number"
            name="durationMinutes"
            defaultValue={event?.durationMinutes ?? defaultDurationMinutes}
            className={inputClass}
          />
        )}
      </Field>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button href="/admin" variant="secondary">
          Cancel
        </Button>
      </div>
    </form>
    {isCompetition && winnerPicker ? (
      <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium text-foreground">Competition winner(s)</h2>
        {winnerPicker}
      </section>
    ) : null}
    </>
  );
}
