"use client";

/**
 * The interactive pieces of /admin/houses. Every write here re-checks
 * houses_write on the server (see admin/houses/actions.ts); `canWrite` only
 * decides whether a control is rendered at all.
 */

import { useActionState, useState, useTransition } from "react";
import {
  calculateHouseMonthAction,
  createManualHouseAwardAction,
  previewHouseMonthAction,
  processEventHouseScoringAction,
  recalculateAllHouseScoringAction,
  revokeHouseAwardAction,
  setCompetitionWinnersAction,
  type HouseActionState,
} from "@/app/(member)/admin/houses/actions";
import ActionButton from "@/components/ui/ActionButton";
import Button from "@/components/ui/Button";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import Field, { inputClass, selectClass } from "@/components/ui/Field";
import HouseDot from "@/components/ui/HouseDot";
import { useToast } from "@/components/ui/Toast";
import type { HouseInfo, HouseMonthPreview } from "@/lib/house-repo";

const INITIAL: HouseActionState = { error: null };

type HouseInfoMap = Record<string, HouseInfo>;

function useResultToast() {
  const { show } = useToast();
  return {
    onSuccess: (s: HouseActionState) => show(s.message ?? "Done"),
    onError: (message: string) => show(message, "error"),
  };
}

/** "Process House scoring" for one closed event. */
export function ProcessEventButton({ eventId, label = "Process House scoring" }: { eventId: string; label?: string }) {
  const toast = useResultToast();
  return (
    <ActionButton
      action={processEventHouseScoringAction}
      initialState={INITIAL}
      payload={{ eventId }}
      label={label}
      pendingLabel="Scoring…"
      variant="secondary"
      {...toast}
    />
  );
}

/** The global "Recalculate all" — confirmed, because it re-snapshots every event against today's roster. */
export function RecalculateAllButton() {
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Recalculate all
      </Button>
      <ConfirmDialog<HouseActionState>
        open={open}
        title="Recalculate all House scoring?"
        description="Every closed House event this season is re-scored against the CURRENT House roster, and every finished month is recalculated — including months already calculated. Each changed award keeps its original numbers for the record. Revoked awards stay revoked."
        confirmLabel="Recalculate all"
        action={recalculateAllHouseScoringAction}
        initialState={INITIAL}
        onCancel={() => setOpen(false)}
        onSuccess={(s) => {
          show(s.message ?? "Recalculated");
          setOpen(false);
        }}
      />
    </>
  );
}

/** Winner picker for an isHouseCompetition event — usable only once the event has closed. */
export function CompetitionWinnersForm({
  eventId,
  winners,
  houses,
  closed,
  canWrite,
}: {
  eventId: string;
  winners: string[];
  houses: HouseInfoMap;
  closed: boolean;
  canWrite: boolean;
}) {
  const { show } = useToast();
  const [state, formAction, pending] = useActionState(async (prev: HouseActionState, fd: FormData) => {
    const next = await setCompetitionWinnersAction(prev, fd);
    if (next.error) show(next.error, "error");
    else show(next.message ?? "Winners saved");
    return next;
  }, INITIAL);
  const disabled = !closed || !canWrite || pending;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="eventId" value={eventId} />
      <fieldset className="flex flex-wrap gap-3" disabled={disabled}>
        <legend className="sr-only">Winning House(s)</legend>
        {Object.values(houses).map((h) => (
          <label key={h.code} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="winners" value={h.code} defaultChecked={winners.includes(h.code)} />
            <HouseDot color={h.color} />
            {h.name}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={disabled}>
          {pending ? "Saving…" : "Save winners"}
        </Button>
        {!closed ? <span className="text-xs text-muted">Available once the event closes.</span> : null}
        {closed && !canWrite ? <span className="text-xs text-muted">Requires the House scoring permission.</span> : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-xs font-medium text-alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** MANUAL award — positive or negative, reason of at least 10 characters. */
export function ManualHouseAwardForm({ houses }: { houses: HouseInfoMap }) {
  const { show } = useToast();
  const [state, formAction, pending] = useActionState(async (prev: HouseActionState, fd: FormData) => {
    const next = await createManualHouseAwardAction(prev, fd);
    if (!next.error) show(next.message ?? "Added");
    return next;
  }, INITIAL);
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_8rem]">
      <Field label="House" required>
        {(id) => (
          <select id={id} name="house" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Select a House…
            </option>
            {Object.values(houses).map((h) => (
              <option key={h.code} value={h.code}>
                {h.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Points" required help="Negative to deduct.">
        {(id) => <input id={id} type="number" name="points" step={1} required className={inputClass} />}
      </Field>
      <div className="sm:col-span-2">
        <Field label="Reason" required help="At least 10 characters — it is shown in the points history.">
          {(id) => <input id={id} name="reason" required minLength={10} className={inputClass} />}
        </Field>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm font-medium text-alert sm:col-span-2">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add award"}
        </Button>
      </div>
    </form>
  );
}

export function RevokeHouseAwardButton({ id, points }: { id: string; points: number }) {
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-semibold text-alert underline underline-offset-2">
        Revoke
      </button>
      <ConfirmDialog<HouseActionState>
        open={open}
        title="Revoke this House award?"
        description={`${points >= 0 ? "The points come off" : "The points go back on"} the House's season total immediately. The row is kept, with your note. Recalculation never un-revokes it.`}
        confirmLabel="Revoke award"
        tone="danger"
        action={revokeHouseAwardAction}
        initialState={INITIAL}
        payload={{ id }}
        reason={{ label: "Reason for revoking", placeholder: "Scored against the wrong event…" }}
        onCancel={() => setOpen(false)}
        onSuccess={() => {
          show("Award revoked");
          setOpen(false);
        }}
      />
    </>
  );
}

/**
 * "Calculate House standings for October". Loads the preview first; for a
 * month that was already calculated the confirmation shows exactly which
 * Houses' points would move.
 */
export function CalculateMonthButton({ month, label, houses }: { month: string; label: string; houses: HouseInfoMap }) {
  const { show } = useToast();
  const [preview, setPreview] = useState<HouseMonthPreview | null>(null);
  const [loading, startLoading] = useTransition();

  function load() {
    startLoading(async () => {
      const r = await previewHouseMonthAction(month);
      if (r.error || !r.preview) show(r.error ?? "Couldn't load the preview", "error");
      else setPreview(r.preview);
    });
  }

  const name = (code: string) => houses[code]?.name ?? code;
  return (
    <>
      <Button variant="secondary" onClick={load} disabled={loading}>
        {loading ? "Loading…" : `Calculate House standings for ${label}`}
      </Button>
      {preview ? (
        <ConfirmDialog<HouseActionState>
          open
          title={preview.calculatedAt ? `Recalculate ${label}?` : `Calculate ${label}?`}
          description={
            <span className="flex flex-col gap-2">
              <span>
                Winner{preview.winners.length === 1 ? "" : "s"}: {preview.winners.map(name).join(", ") || "none"} (2 points each).
              </span>
              {preview.calculatedAt ? (
                preview.diff.length === 0 ? (
                  <span>Already calculated — recalculating would change nothing.</span>
                ) : (
                  <span>
                    Already calculated. This would change:{" "}
                    {preview.diff.map((d) => `${name(d.house)} ${d.from ?? "—"} → ${d.to}`).join("; ")}.
                  </span>
                )
              ) : null}
            </span>
          }
          confirmLabel={preview.calculatedAt ? "Recalculate" : "Calculate"}
          action={calculateHouseMonthAction}
          initialState={INITIAL}
          payload={{ month }}
          onCancel={() => setPreview(null)}
          onSuccess={(s) => {
            show(s.message ?? "Calculated");
            setPreview(null);
          }}
        />
      ) : null}
    </>
  );
}
