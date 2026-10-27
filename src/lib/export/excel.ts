/**
 * Shared exceljs report styling — frozen header row, bold navy header, column
 * widths sized to content. Used by every sheet in lib/export/workbook.ts so
 * the workbook reads like a report, not a data dump.
 */

import ExcelJS from "exceljs";

const HEADER_FILL = "FF1B2A4A"; // navy
const HEADER_TEXT = "FFFFFFFF";

const MAX_SHEET_NAME = 31;

/**
 * A legal sheet name not already used in this workbook. Excel allows 31
 * characters, none of [ ] : * ? / \, no leading/trailing apostrophe, and
 * reserves "History"; exceljs throws on a name that repeats an existing one
 * case-insensitively. Truncation alone is what used to make the full workbook
 * export 500: two events whose slugs share their first 21 characters
 * (general-body-meeting-2026, general-body-meeting-2026-2) both became
 * "Responses_general-body-meeting-". A clash now gets a "~2", "~3"… suffix,
 * cut in so the whole name still fits.
 */
export function uniqueSheetName(workbook: ExcelJS.Workbook, name: string): string {
  let base = name.replace(/[[\]:*?/\\]/g, "-").replace(/^'+|'+$/g, "").trim() || "Sheet";
  if (base.toLowerCase() === "history") base = "History-";
  base = base.slice(0, MAX_SHEET_NAME);
  const taken = new Set(workbook.worksheets.map((ws) => ws.name.toLowerCase()));
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = `~${n}`;
    candidate = `${base.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
  }
  return candidate;
}

export function addReportSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Array<Array<string | number | null>>,
  options?: { note?: string },
): ExcelJS.Worksheet {
  const safeName = uniqueSheetName(workbook, name);
  // A note (e.g. the leaderboard disclaimer) pushes the header down to row 2
  // and gets its own merged, italic row 1 — everything else about the sheet
  // (freeze pane, header styling, column widths) targets that shifted row.
  const headerRowIndex = options?.note ? 2 : 1;
  const ws = workbook.addWorksheet(safeName, { views: [{ state: "frozen", ySplit: headerRowIndex }] });

  ws.columns = headers.map((h) => ({ key: h }));
  if (options?.note) {
    const noteRow = ws.addRow([options.note]);
    ws.mergeCells(1, 1, 1, headers.length);
    noteRow.font = { italic: true, color: { argb: "FF5A6485" } };
    noteRow.height = 18;
  }
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);

  const headerRow = ws.getRow(headerRowIndex);
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle" };
  });

  ws.columns.forEach((col, i) => {
    let max = headers[i].length;
    for (const row of rows) {
      const v = row[i];
      if (v !== null && v !== undefined) max = Math.max(max, String(v).length);
    }
    col.width = Math.min(48, Math.max(12, max + 2));
  });

  return ws;
}
