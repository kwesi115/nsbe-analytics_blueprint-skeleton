import Link from "next/link";
import { guardAdminPage } from "@/lib/access-guards";
import AccessDenied from "../_components/AccessDenied";
import AdminNav from "@/components/admin/AdminNav";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import HouseDot from "@/components/ui/HouseDot";
import { getHouseBoard, getHouseSeasons } from "@/lib/house-repo";

/**
 * Every season's final House standings. A season rollover (bumping
 * Config.SEASON in Settings) empties the live House leaderboard the same way
 * it empties the member one — award rows are season-stamped and the board
 * reads only the current season — and nothing is deleted: each prior season
 * is still here, derived from the same rows.
 */
export default async function SeasonsPage() {
  const guard = await guardAdminPage({ level: "eboard" });
  if (!guard.ok) return <AccessDenied denied={guard} />;
  const orgId = guard.session.user.orgId;
  const seasons = await getHouseSeasons(orgId);
  const boards = await Promise.all(seasons.map((s) => getHouseBoard(orgId, s)));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <h1 className="font-display text-2xl font-bold text-foreground">Seasons</h1>
      <AdminNav active="/admin/seasons" access={guard.access} />
      {boards.length === 0 ? <p className="text-sm text-muted">No seasons yet — set the current season in Settings.</p> : null}
      {boards.map((b) => (
        <Card key={b.season}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-foreground">
              {b.season} {b.season === b.currentSeason ? <Badge tone="signal">Current</Badge> : null}
            </h2>
            <Link href={b.season === b.currentSeason ? "/admin/houses" : `/admin/houses?season=${b.season}`} className="text-sm underline">
              House details
            </Link>
          </div>
          <ol className="mt-3 flex flex-col gap-1 text-sm">
            {b.totals.map((t) => (
              <li key={t.house} className="flex items-center gap-2">
                <span className="w-8 font-semibold">{b.totals.filter((o) => o.rank === t.rank).length > 1 ? `T-${t.rank}` : t.rank}</span>
                <HouseDot color={t.color} /> {t.name}
                <span className="ml-auto font-semibold">{t.total} pts</span>
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </main>
  );
}
