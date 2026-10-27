/**
 * Runs against the real Postgres instance at DATABASE_URL — exports whatever
 * is currently in the dev DB (seeded PointSystem/Config/admin at minimum) and
 * inspects the generated workbook's raw cell values.
 */

import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEFAULT_LEADERBOARD_DISCLAIMER, getConfigValue } from "@/lib/repo";
import { createTestOrg, makeClosedEvent } from "@/test/db-fixtures";
import { buildWorkbookExport } from "./workbook";

// A full season workbook built from the database — comfortably under 5s alone, but not under the
// full suite's parallel database load. Same allowance as src/auth.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const FORBIDDEN_SUBSTRINGS = ["passwordhash", "verificationtoken", "joincode", "$2a$", "$2b$"]; // bcrypt hash prefixes too

describe("buildWorkbookExport — no sensitive data", () => {
  it("contains no passwordHash, verificationToken, or join code anywhere in the workbook", async () => {
    const org = await prisma.org.findFirstOrThrow();
    const buffer = await buildWorkbookExport(org.id);
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buffer as any);

    for (const ws of wb.worksheets) {
      // Header row: no column literally named after a credential field.
      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell) => {
        const header = String(cell.value ?? "").toLowerCase();
        expect(header).not.toContain("password");
        expect(header).not.toContain("verificationtoken");
        expect(header).not.toContain("joincode");
      });

      // Every cell value in the sheet: no bcrypt hash or raw token substring.
      ws.eachRow((row) => {
        row.eachCell((cell) => {
          const value = String(cell.value ?? "").toLowerCase();
          for (const forbidden of FORBIDDEN_SUBSTRINGS) {
            expect(value).not.toContain(forbidden);
          }
        });
      });
    }

    // The Members sheet specifically must not exist with any credential column.
    const members = wb.getWorksheet("Members");
    expect(members).toBeDefined();
    const memberHeaders = (members!.getRow(1).values as unknown[]).map((v) => String(v ?? "").toLowerCase());
    expect(memberHeaders.some((h) => h.includes("password") || h.includes("token") || h.includes("code"))).toBe(false);
  });
});

describe("buildWorkbookExport — Leaderboard sheet disclaimer", () => {
  it("carries the Config.LEADERBOARD_DISCLAIMER text as a note above the header row", async () => {
    const org = await prisma.org.findFirstOrThrow();
    const disclaimer = await getConfigValue(org.id, "LEADERBOARD_DISCLAIMER", DEFAULT_LEADERBOARD_DISCLAIMER);

    const buffer = await buildWorkbookExport(org.id);
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buffer as any);

    const sheet = wb.getWorksheet("Leaderboard");
    expect(sheet).toBeDefined();
    expect(sheet!.getCell(1, 1).value).toBe(disclaimer);
    expect(sheet!.getCell(2, 1).value).toBe("Rank");
  });
});

describe("buildWorkbookExport — per-event Responses sheets", () => {
  // Excel caps a sheet name at 31 characters and exceljs refuses a duplicate
  // (case-insensitively). "Responses_" + a recurring event's slug collides
  // once truncated: general-body-meeting-2026 and general-body-meeting-2026-2
  // are both "Responses_general-body-meeting-". That threw, and the route
  // turned it into a bare 500.
  it("exports events whose slugs only differ past the 31-character sheet-name limit", async () => {
    const org = await createTestOrg("workbook-sheets");
    try {
      const slugs = ["general-body-meeting-2026", "general-body-meeting-2026-2", "GENERAL-BODY-MEETING-2026-3"];
      for (const slug of slugs) {
        const e = await makeClosedEvent(org.orgId, org.gbmCategoryId, { name: "General Body Meeting" });
        await prisma.event.update({ where: { id: e.id }, data: { slug } });
      }

      const buffer = await buildWorkbookExport(org.orgId);
      const wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await wb.xlsx.load(buffer as any);

      const responseSheets = wb.worksheets.filter((ws) => ws.name.startsWith("Responses_"));
      expect(responseSheets).toHaveLength(3);
      expect(new Set(responseSheets.map((ws) => ws.name.toLowerCase())).size).toBe(3);
      for (const ws of responseSheets) expect(ws.name.length).toBeLessThanOrEqual(31);
      // A truncated tab name can't say which event it is, so the sheet does.
      const notes = responseSheets.map((ws) => String(ws.getCell(1, 1).value));
      for (const slug of slugs) expect(notes.some((n) => n.includes(slug))).toBe(true);
    } finally {
      await org.cleanup();
    }
  });
});
