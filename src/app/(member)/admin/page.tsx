import { guardAdminPage } from "@/lib/access-guards";
import AccessDenied from "./_components/AccessDenied";
import { ShieldAlert } from "lucide-react";
import { after } from "next/server";
import AdminNav from "@/components/admin/AdminNav";
import EventsBoard from "@/components/admin/EventsBoard";
import Button from "@/components/ui/Button";
import { getEventCodeAlertState } from "@/lib/rate-limit";
import { runHouseScoringSweep } from "@/lib/house-repo";
import { getEventsWithStats, runTrashSweep } from "@/lib/repo";

export default async function AdminEventsPage() {
  const guard = await guardAdminPage({ level: "eboard" });
  if (!guard.ok) return <AccessDenied denied={guard} />;
  const session = guard.session;
  const orgId = session.user.orgId;
  // The trash bin's lazy expiry — there is no cron in this project. Runs after
  // the response so a sweep never slows this page down, and at most once an
  // hour however many officers load it (runTrashSweep claims the slot
  // atomically). A failure is logged, never shown: this page isn't about the trash.
  after(async () => {
    try {
      await runTrashSweep(orgId);
    } catch (err) {
      console.error("[trash] lazy sweep failed", err);
    }
    // House scoring rides the same lazy hook: closed events that are due get
    // scored and finished months get their first Own the Month calculation.
    // Rate-limited on its own key (see lib/house-repo.ts runHouseScoringSweep).
    try {
      await runHouseScoringSweep(orgId);
    } catch (err) {
      console.error("[houses] lazy sweep failed", err);
    }
  });
  const events = await getEventsWithStats(orgId);
  const eventsWithAlerts = events.map((e) => ({ ...e, codeAlert: getEventCodeAlertState(e.eventId) }));
  const suspiciousEvents = eventsWithAlerts.filter((e) => e.codeAlert.suspicious);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold text-foreground">Events</h1>
        <Button href="/admin/events/new">New event</Button>
      </div>
      <AdminNav active="/admin" access={guard.access} />

      {suspiciousEvents.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-torch-border bg-torch-subtle px-4 py-3 text-sm text-foreground">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldAlert size={16} aria-hidden="true" /> Unusual check-in code activity
          </p>
          <ul className="flex flex-col gap-1">
            {suspiciousEvents.map((e) => (
              <li key={e.eventId} className="text-xs text-muted">
                {e.name} — {e.codeAlert.locked ? "check-in paused" : "elevated failed-attempt volume"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <EventsBoard
        initialEvents={eventsWithAlerts}
        exportsEnabled={guard.access.features.exports}
        canDelete={guard.access.role === "admin"}
      />
    </main>
  );
}
