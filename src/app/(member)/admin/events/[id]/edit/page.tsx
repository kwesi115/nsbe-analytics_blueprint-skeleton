import { guardAdminPage } from "@/lib/access-guards";
import AccessDenied from "../../../_components/AccessDenied";
import { notFound } from "next/navigation";
import { updateEventAction } from "@/app/(member)/admin/events/actions";
import EventForm from "@/components/admin/EventForm";
import { CompetitionWinnersForm } from "@/components/admin/houses/HouseControls";
import { isAllowed } from "@/lib/access";
import { getHouseInfo } from "@/lib/house-repo";
import { isOpen } from "@/lib/points";
import { getConfigValue, getEvent, getEventCategories, getEventGroups } from "@/lib/repo";

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const guard = await guardAdminPage({ level: "eboard" });
  if (!guard.ok) return <AccessDenied denied={guard} />;
  const session = guard.session;
  const { id } = await params;
  const [event, categories, groups, defaultDuration, houses] = await Promise.all([
    getEvent(session.user.orgId, id),
    getEventCategories(session.user.orgId),
    getEventGroups(session.user.orgId),
    getConfigValue(session.user.orgId, "DEFAULT_EVENT_DURATION", "20"),
    getHouseInfo(session.user.orgId),
  ]);
  if (!event) notFound();
  // Closed = it ran and its window is over. Winners can't be picked before that.
  const now = new Date();
  const closed = event.status === "scheduled" && event.closesAt !== null && !isOpen(event, now) && event.closesAt <= now;

  const action = updateEventAction.bind(null, event.eventId);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="font-display text-2xl font-bold text-foreground">Edit {event.name}</h1>
      <EventForm
        action={action}
        event={event}
        categories={categories}
        groups={groups}
        submitLabel="Save changes"
        defaultDurationMinutes={Number(defaultDuration)}
        winnerPicker={
          <CompetitionWinnersForm
            eventId={event.eventId}
            winners={event.house?.competitionWinners ?? []}
            houses={houses}
            closed={closed}
            canWrite={isAllowed(guard.access, { level: "permission", permission: "houses_write" })}
          />
        }
      />
    </main>
  );
}
