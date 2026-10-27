import { NextResponse } from "next/server";
import { runHouseScoringSweep } from "@/lib/house-repo";
import { getActiveOrgs } from "@/lib/repo";

/**
 * House scoring, callable by a scheduler — the counterpart of
 * /api/cron/trash-sweep, with the same CRON_SECRET bearer check and the same
 * refusal to run open when no secret is configured. No schedule is configured
 * in this project; without one, scoring runs lazily on /admin and
 * /admin/houses loads (see lib/house-repo.ts runHouseScoringSweep).
 *
 * Goes through the sweep's own rate-limit claim, so a cron firing while an
 * admin page is sweeping does nothing twice.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ code: "NOT_CONFIGURED", message: "CRON_SECRET is not set." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ code: "UNAUTHENTICATED", message: "Unauthorized" }, { status: 401 });
  }

  const results: Array<{ org: string; error?: string; ran?: boolean; eventsScored?: number; monthsCalculated?: string[]; failures?: number }> = [];
  for (const org of await getActiveOrgs()) {
    try {
      const r = await runHouseScoringSweep(org.id, { actor: "cron" });
      results.push(
        r.ran
          ? { org: org.slug, ran: true, eventsScored: r.eventsScored, monthsCalculated: r.monthsCalculated, failures: r.failures.length }
          : { org: org.slug, ran: false },
      );
    } catch (err) {
      console.error("[houses] cron sweep failed", { org: org.slug, err });
      results.push({ org: org.slug, error: "Sweep failed — see server logs." });
    }
  }
  return NextResponse.json({ results });
}
