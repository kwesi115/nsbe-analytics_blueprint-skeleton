import Link from "next/link";
import { after } from "next/server";
import { guardAdminPage } from "@/lib/access-guards";
import { isAllowed } from "@/lib/access";
import AccessDenied from "../_components/AccessDenied";
import AdminNav from "@/components/admin/AdminNav";
import {
  CalculateMonthButton,
  CompetitionWinnersForm,
  ManualHouseAwardForm,
  ProcessEventButton,
  RecalculateAllButton,
  RevokeHouseAwardButton,
} from "@/components/admin/houses/HouseControls";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import HouseDot from "@/components/ui/HouseDot";
import Table, { tdClass, thClass, Thead } from "@/components/ui/Table";
import { formatDate, formatDateTime, formatMonthKey } from "@/lib/format";
import {
  getHouseBoard,
  getHouseEventStats,
  getHouseInfo,
  getHouseMembership,
  getHouseMonthlyStandings,
  getHousePointsHistory,
  runHouseScoringSweep,
} from "@/lib/house-repo";
import { HOUSE_CATEGORY_LABEL, HOUSE_CODES, type HouseCategoryCode, type HouseCode } from "@/lib/house-scoring";

const CATEGORIES: HouseCategoryCode[] = ["SHOW_UP", "REP_YOUR_HOUSE", "WIN", "OWN_THE_MONTH", "MANUAL"];

function pct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

function Section({ id, title, children, action }: { id: string; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default async function HousesPage({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  const guard = await guardAdminPage({ level: "eboard" });
  if (!guard.ok) return <AccessDenied denied={guard} />;
  const orgId = guard.session.user.orgId;
  const canWrite = isAllowed(guard.access, { level: "permission", permission: "houses_write" });

  // The same lazy, rate-limited sweep /admin runs — there is no cron. After
  // the response, so it never slows this page; the next load shows its work.
  after(async () => {
    try {
      await runHouseScoringSweep(orgId);
    } catch (err) {
      console.error("[houses] lazy sweep failed", err);
    }
  });

  const requested = (await searchParams).season;
  const board = await getHouseBoard(orgId, requested);
  const season = board.season;
  const viewingCurrent = season === board.currentSeason;
  const [info, history, membership, events, monthly] = await Promise.all([
    getHouseInfo(orgId),
    getHousePointsHistory(orgId, season),
    getHouseMembership(orgId, season),
    getHouseEventStats(orgId, season),
    getHouseMonthlyStandings(orgId, season),
  ]);
  const name = (h: HouseCode) => info[h].name;
  const leader = board.totals[0];
  const tiedAtTop = board.totals.filter((t) => t.rank === 1);
  const competitions = events.filter((e) => e.flags.competition);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold text-foreground">Houses</h1>
        {canWrite && viewingCurrent ? <RecalculateAllButton /> : null}
      </div>
      <AdminNav active="/admin/houses" access={guard.access} />

      {!viewingCurrent ? (
        <p className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-foreground">
          Viewing the {season} season (read-only history). <Link href="/admin/houses" className="underline">Back to {board.currentSeason}</Link> ·{" "}
          <Link href="/admin/seasons" className="underline">All seasons</Link>
        </p>
      ) : null}

      <Section id="leaderboard" title={`House Leaderboard — ${season}`}>
        <Card>
          <p className="text-sm text-muted">House of the Year standing</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-bold text-foreground">
            {leader && leader.total !== 0 ? (
              <>
                {tiedAtTop.map((t) => (
                  <span key={t.house} className="flex items-center gap-1.5">
                    <HouseDot color={t.color} /> {t.name}
                  </span>
                ))}
                <span className="text-sm font-normal text-muted">
                  {tiedAtTop.length > 1 ? "tied " : ""}with {leader.total} pts{viewingCurrent ? " — season in progress" : ""}
                </span>
              </>
            ) : (
              <span className="text-sm font-normal text-muted">No House points yet this season.</span>
            )}
          </p>
        </Card>
        <Table>
          <Thead>
            <th className={`${thClass} pl-4`}>Rank</th>
            <th className={thClass}>House</th>
            <th className={thClass}>Total</th>
            {CATEGORIES.map((c) => (
              <th key={c} className={thClass}>
                {HOUSE_CATEGORY_LABEL[c]}
              </th>
            ))}
          </Thead>
          <tbody>
            {board.totals.map((t) => (
              <tr key={t.house} className="border-b border-border last:border-0">
                <td className={`${tdClass} pl-4 font-semibold`}>
                  {board.totals.filter((o) => o.rank === t.rank).length > 1 ? `T-${t.rank}` : t.rank}
                </td>
                <td className={tdClass}>
                  <span className="flex items-center gap-2 font-semibold">
                    <HouseDot color={t.color} /> {t.name}
                  </span>
                </td>
                <td className={`${tdClass} font-bold`}>{t.total}</td>
                {CATEGORIES.map((c) => (
                  <td key={c} className={tdClass}>
                    {t.byCategory[c]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-xs text-muted">
          Totals are summed from the points history below, every time. Awards on events in the trash and revoked awards
          don&apos;t count. The breakdown columns are the Points breakdown by category.
        </p>
      </Section>

      <Section id="monthly" title="Monthly standings (Own the Month)">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-foreground">
              {monthly.current.label} <Badge tone="amber">Provisional</Badge>
            </p>
            <p className="text-xs text-muted">
              Live average across {monthly.current.events.length} eligible event(s) so far — awarded after the month ends.
            </p>
          </div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-4">
            {HOUSE_CODES.map((h) => (
              <li key={h} className="flex items-center gap-2 text-sm">
                <HouseDot color={info[h].color} /> {name(h)}: <strong>{pct(monthly.current.averages[h].average)}</strong>
                {monthly.current.winners.includes(h) ? <Badge tone="signal">Leading</Badge> : null}
              </li>
            ))}
          </ul>
        </Card>

        {monthly.needingRecalculation.length > 0 ? (
          <div role="status" className="rounded-xl border border-torch-border bg-torch-subtle px-4 py-3 text-sm text-foreground">
            <p className="font-semibold">Months that may need recalculation</p>
            <ul className="mt-1 flex flex-col gap-1 text-xs">
              {monthly.needingRecalculation.map((m) => (
                <li key={m.month}>
                  {m.label} (calculated {formatDateTime(m.calculatedAt)}):{" "}
                  {m.events.map((e) => `${e.name} — ${e.why === "trashed" ? "moved to the trash" : "attendance or House flags changed"}`).join("; ")}.
                  Not recalculated automatically.
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Table>
          <Thead>
            <th className={`${thClass} pl-4`}>Month</th>
            <th className={thClass}>Winner(s)</th>
            <th className={thClass}>Calculated</th>
            <th className={thClass}></th>
          </Thead>
          <tbody>
            {monthly.past.length === 0 ? (
              <tr>
                <td colSpan={4} className={`${tdClass} pl-4 text-muted`}>
                  No finished months with eligible events yet.
                </td>
              </tr>
            ) : (
              monthly.past.map((m) => (
                <tr key={m.month} className="border-b border-border last:border-0">
                  <td className={`${tdClass} pl-4`}>{m.label}</td>
                  <td className={tdClass}>
                    {m.calculatedAt ? (m.winners.length ? m.winners.map(name).join(", ") : "None") : <span className="text-muted">Not calculated</span>}
                  </td>
                  <td className={tdClass}>{m.calculatedAt ? formatDateTime(m.calculatedAt) : "—"}</td>
                  <td className={tdClass}>
                    {canWrite && viewingCurrent ? <CalculateMonthButton month={m.month} label={formatMonthKey(m.month)} houses={info} /> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Section>

      <Section id="attendance" title="Attendance stats">
        <p className="text-xs text-muted">
          Each House&apos;s percentage at every closed House event this season, against the <strong>current</strong> roster
          (verified General members only — E-Board, unverified and trashed members are excluded from both sides). What an
          award said at the time it was scored is in the points history.
        </p>
        <Table>
          <Thead>
            <th className={`${thClass} pl-4`}>Event</th>
            {HOUSE_CODES.map((h) => (
              <th key={h} className={thClass}>
                <span className="flex items-center gap-1.5">
                  <HouseDot color={info[h].color} /> {name(h)}
                </span>
              </th>
            ))}
            <th className={thClass}>Scoring</th>
          </Thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={6} className={`${tdClass} pl-4 text-muted`}>
                  No closed House events this season. Tick the House Scoring boxes on an event to include it.
                </td>
              </tr>
            ) : (
              events.map((e) => (
                <tr key={e.eventId} className="border-b border-border last:border-0">
                  <td className={`${tdClass} pl-4`}>
                    <span className="font-medium">{e.name}</span>
                    <span className="block text-xs text-muted">
                      {formatDate(e.closesAt)} ·{" "}
                      {[e.flags.showUp && "Show Up", e.flags.repYourHouse && "Rep", e.flags.monthly && "Monthly", e.flags.competition && "Competition"]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </td>
                  {HOUSE_CODES.map((h) => (
                    <td key={h} className={tdClass}>
                      {pct(e.perHouse[h].percentage)}
                      <span className="block text-xs text-muted">
                        {e.perHouse[h].attendeeCount}/{e.perHouse[h].rosterCount}
                      </span>
                    </td>
                  ))}
                  <td className={tdClass}>
                    <span className="block text-xs text-muted">
                      {e.houseScoredAt ? `Scored ${formatDateTime(e.houseScoredAt)}` : "Not scored yet"}
                      {e.stale ? " · due again" : ""}
                    </span>
                    {canWrite && viewingCurrent && (e.flags.showUp || e.flags.repYourHouse || e.flags.competition) ? (
                      <ProcessEventButton eventId={e.eventId} />
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Section>

      <Section id="competitions" title="Competitions">
        {competitions.length === 0 ? (
          <p className="text-sm text-muted">No closed House competitions this season. Mark an event as a House competition when you create or edit it.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {competitions.map((e) => (
              <Card key={e.eventId}>
                <p className="font-semibold text-foreground">
                  {e.name} <span className="text-xs font-normal text-muted">{formatDate(e.closesAt)}</span>
                </p>
                <div className="mt-2">
                  <CompetitionWinnersForm eventId={e.eventId} winners={e.competitionWinners} houses={info} closed canWrite={canWrite && viewingCurrent} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section id="membership" title="Membership">
        <p className="text-xs text-muted">
          Only verified General members count toward a House. Attendance is out of {membership.events} closed House event(s)
          this season.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {membership.houses.map((m) => (
            <Card key={m.house}>
              <details>
                <summary className="flex cursor-pointer items-center gap-2 font-semibold text-foreground">
                  <HouseDot color={info[m.house].color} /> {name(m.house)} — {m.members.length} member(s)
                </summary>
                <p className="mt-2 text-xs text-muted">
                  Not counted: {m.pendingCount} awaiting House verification, {m.officerCount} E-Board/admin.
                </p>
                <ul className="mt-2 flex flex-col divide-y divide-border text-sm">
                  {m.members.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <Link href={`/admin/members/${u.id}`} className="font-medium underline-offset-2 hover:underline">
                          {u.name}
                        </Link>
                        <span className="block text-xs text-muted">{u.email}</span>
                      </span>
                      <span className="text-xs text-muted">
                        {u.attended}/{membership.events} events
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          ))}
        </div>
      </Section>

      {canWrite && viewingCurrent ? (
        <Section id="manual" title="Manual adjustment">
          <Card>
            <ManualHouseAwardForm houses={info} />
          </Card>
        </Section>
      ) : null}

      <Section id="history" title="Points history">
        <Table>
          <Thead>
            <th className={`${thClass} pl-4`}>Date</th>
            <th className={thClass}>House</th>
            <th className={thClass}>Category</th>
            <th className={thClass}>Event / month</th>
            <th className={thClass}>Points</th>
            <th className={thClass}>Why</th>
            <th className={thClass}></th>
          </Thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td colSpan={7} className={`${tdClass} pl-4 text-muted`}>
                  No House awards this season yet.
                </td>
              </tr>
            ) : (
              history.map((r) => {
                const inactive = r.revokedAt !== null || r.eventInTrash;
                return (
                  <tr key={r.id} className={`border-b border-border last:border-0 ${inactive || r.points === 0 ? "text-muted" : ""}`}>
                    <td className={`${tdClass} pl-4`}>{formatDate(r.awardedAt)}</td>
                    <td className={tdClass}>
                      <span className="flex items-center gap-1.5">
                        <HouseDot color={info[r.house].color} /> {name(r.house)}
                      </span>
                    </td>
                    <td className={tdClass}>{HOUSE_CATEGORY_LABEL[r.category]}</td>
                    <td className={tdClass}>
                      {r.eventName ?? (r.periodMonth ? formatMonthKey(r.periodMonth) : "—")}
                      {r.eventInTrash ? <span className="block text-xs">In the trash — not counted</span> : null}
                    </td>
                    <td className={`${tdClass} font-semibold`}>{r.points > 0 ? `+${r.points}` : r.points}</td>
                    <td className={tdClass}>
                      <span className="block">{r.reason}</span>
                      {r.percentage !== null ? (
                        <span className="block text-xs text-muted">
                          {r.attendeeCount !== null ? `${r.attendeeCount}/${r.rosterCount} = ` : ""}
                          {pct(r.percentage)}
                        </span>
                      ) : null}
                      {r.originalSnapshot ? (
                        <span className="block text-xs text-muted">
                          Recalculated {formatDateTime(r.recalculatedAt)} — originally {r.originalSnapshot.points} pt(s)
                          {r.originalSnapshot.attendeeCount !== null
                            ? ` at ${r.originalSnapshot.attendeeCount}/${r.originalSnapshot.rosterCount}`
                            : ""}
                          {r.originalSnapshot.percentage !== null ? ` (${pct(r.originalSnapshot.percentage)})` : ""}
                        </span>
                      ) : null}
                      <span className="block text-xs text-muted">{r.awardedBy ? `Awarded by ${r.awardedBy}` : "Automatic"}</span>
                    </td>
                    <td className={tdClass}>
                      {r.revokedAt ? (
                        <span className="text-xs">
                          Revoked{r.revokedBy ? ` by ${r.revokedBy}` : ""}: {r.revokeNote}
                        </span>
                      ) : canWrite && viewingCurrent && r.points !== 0 ? (
                        <RevokeHouseAwardButton id={r.id} points={r.points} />
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Section>
    </main>
  );
}
