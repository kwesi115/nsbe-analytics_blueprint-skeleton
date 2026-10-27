/**
 * Generates the full season workbook on demand, read-only — nothing is ever
 * written back. Postgres is the system of record; this is purely a report.
 * Members sheet NEVER includes passwordHash, verificationToken, or any join
 * code — those columns don't exist on the domain Member type this reads from,
 * so there's no column to accidentally forget to strip.
 */

import ExcelJS from "exceljs";
import { formatClassification, formatDateTime } from "@/lib/format";
import {
  DEFAULT_LEADERBOARD_DISCLAIMER,
  getAdminLog,
  getAttendance,
  getConfigValue,
  getEboardBoardRows,
  getEventCategories,
  getEvents,
  getEventResponses,
  getFormFields,
  getMembers,
  getStandings,
} from "@/lib/repo";
import { addReportSheet } from "./excel";

export async function buildWorkbookExport(orgId: string): Promise<Buffer> {
  const [members, events, attendance, categories, standings, adminLog, eboardRows, leaderboardDisclaimer] = await Promise.all([
    getMembers(orgId),
    getEvents(orgId),
    getAttendance(orgId),
    getEventCategories(orgId),
    getStandings(orgId),
    getAdminLog(orgId),
    getEboardBoardRows(orgId),
    getConfigValue(orgId, "LEADERBOARD_DISCLAIMER", DEFAULT_LEADERBOARD_DISCLAIMER),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = "NSBE Points Tracker";
  wb.created = new Date();

  addReportSheet(
    wb,
    "Members",
    ["Email", "First Name", "Last Name", "Student ID", "Classification", "Major", "Membership", "House", "Role", "Status", "Joined"],
    members.map((m) => [
      m.email,
      m.firstName,
      m.lastName,
      m.studentId,
      formatClassification(m.classification),
      m.major,
      m.membership,
      m.house,
      m.role,
      m.status,
      formatDateTime(m.joinedAt),
    ]),
  );

  const eventById = new Map(events.map((e) => [e.eventId, e]));
  addReportSheet(
    wb,
    "Events",
    ["Name", "Slug", "Category", "Date", "Location", "Status", "Audience", "Opens", "Closes", "Points Override", "Created By"],
    events.map((e) => [
      e.name,
      e.slug,
      e.category.shortName,
      formatDateTime(e.date),
      e.location,
      e.status,
      e.audience,
      formatDateTime(e.opensAt),
      formatDateTime(e.closesAt),
      e.points,
      e.createdBy,
    ]),
  );

  addReportSheet(
    wb,
    "Registrations",
    ["Timestamp", "Event", "Audience", "Email", "Role at time", "Points", "Source", "Note"],
    attendance.map((a) => [
      formatDateTime(a.timestamp),
      eventById.get(a.eventId)?.name ?? a.eventId,
      eventById.get(a.eventId)?.audience ?? "",
      a.email,
      a.role,
      a.pointsAwarded,
      a.source,
      a.note,
    ]),
  );

  addReportSheet(
    wb,
    "Categories",
    ["Code", "Name", "Short Name", "Tier", "Member Points", "Counts For Monthly", "E-Board Eligible", "Audience", "Active"],
    categories.map((c) => [
      c.code,
      c.name,
      c.shortName,
      c.tier,
      c.memberPoints,
      c.countsForMonthly ? "Yes" : "No",
      c.eboardEligible ? "Yes" : "No",
      c.audience,
      c.active ? "Yes" : "No",
    ]),
  );

  addReportSheet(
    wb,
    "Leaderboard",
    ["Rank", "First Name", "Last Name", "Email", "Points", "Events"],
    standings.map((s) => [s.rank, s.firstName, s.lastName, s.email, s.points, s.events]),
    { note: leaderboardDisclaimer },
  );

  // Same admin-only gate as everything else in this export — see
  // src/app/api/admin/export/workbook/route.ts's requireAdmin() call.
  addReportSheet(
    wb,
    "E-Board Leaderboard",
    [
      "Rank",
      "First Name",
      "Last Name",
      "Email",
      "Position",
      "Total Points",
      "Total Events",
      "Chapter Points",
      "Chapter Attended",
      "Chapter Eligible",
      "E-Board Meeting Points",
      "E-Board Meeting Attended",
      "E-Board Meeting Eligible",
      "Retreat Points",
      "Retreat Attended",
      "Retreat Eligible",
    ],
    eboardRows.map((r) => [
      r.rank,
      r.firstName,
      r.lastName,
      r.email,
      r.eboardPosition,
      r.points,
      r.events,
      r.chapter.points,
      r.chapter.attended,
      r.chapter.eligible,
      r.eboardMeetings.points,
      r.eboardMeetings.attended,
      r.eboardMeetings.eligible,
      r.retreats.points,
      r.retreats.attended,
      r.retreats.eligible,
    ]),
  );

  addReportSheet(
    wb,
    "AdminLog",
    ["Timestamp", "Actor", "Action", "Target", "Detail"],
    adminLog.map((l) => [formatDateTime(l.timestamp), l.actor, l.action, l.target, l.detail]),
  );

  for (const event of events) {
    const [fields, responses] = await Promise.all([getFormFields(orgId, event.eventId), getEventResponses(orgId, event.eventId)]);
    const headers = ["Timestamp", "Email", "First Name", "Last Name", "Points", ...fields.map((f) => f.label || f.fieldKey)];
    const rows = responses.map((r) => [
      formatDateTime(r.timestamp),
      r.email,
      r.firstName,
      r.lastName,
      r.pointsAwarded,
      ...fields.map((f) => r.answers[f.fieldKey] ?? ""),
    ]);
    // The tab name is truncated (and suffixed on a clash — see
    // uniqueSheetName), so the sheet itself names the event it holds.
    addReportSheet(wb, `Responses_${event.slug}`, headers, rows, {
      note: `${event.name} (${event.slug}) — ${formatDateTime(event.date)}`,
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
