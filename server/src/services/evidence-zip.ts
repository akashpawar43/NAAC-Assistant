// Evidence ZIP: every uploaded proof in Criterion / Metric / Document-type folders, plus an
// index (CSV, opens in Excel) that also lists required documents that are still missing.
import archiver from "archiver";
import type { FileStore } from "../infra/file-store.js";
import { reportFileName, type ReportModel } from "./report.js";

const safe = (s: string, max = 80) =>
  s
    .replace(/\s*[/\\]\s*/g, " - ") // "Letters / receipts" -> "Letters - receipts"
    .replace(/[<>:"|?*\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, max) || "untitled";

/**
 * One CSV cell. A cell starting with = + - @ (or tab / CR) is a formula to Excel, and file names
 * and labels here are typed by users, so such cells get a leading apostrophe (OWASP CSV injection).
 */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Streams the ZIP into `archive` (already piped to the response). Files are read from the
 * store one at a time, so memory stays bounded by the largest single upload.
 */
export async function writeEvidenceZip(r: ReportModel, files: FileStore, archive: archiver.Archiver): Promise<{ files: number; missing: number }> {
  const root = safe(reportFileName(r, "zip").replace(/\.zip$/, ""), 120);
  const index: string[][] = [["Criterion", "Metric", "Metric title", "Document", "File", "Path in ZIP"]];
  const taken = new Set<string>();
  let count = 0;
  let missing = 0;
  for (const c of r.criteria) {
    const cDir = `Criterion ${c.id} - ${safe(c.title, 60)}`;
    for (const x of c.metrics) {
      const mDir = `${cDir}/${x.m.id}`;
      for (const e of x.evidence) {
        let path = `${mDir}/${safe(e.label, 60)}/${safe(e.filename, 100)}`;
        // Two uploads with the same name: "offer.pdf", "offer (2).pdf".
        for (let n = 2; taken.has(path.toLowerCase()); n++) {
          path = `${mDir}/${safe(e.label, 60)}/${safe(e.filename.replace(/(\.[^.]+)?$/, ` (${n})$1`), 100)}`;
        }
        taken.add(path.toLowerCase());
        const written = new Promise((res) => archive.once("entry", res));
        archive.append(await files.get(e.file_key), { name: `${root}/${path}` });
        await written; // wait until this file is compressed before reading the next one
        index.push([c.id, x.m.id, x.m.title, e.label, e.filename, path]);
        count++;
      }
      for (const d of x.m.evidence) {
        if (d.required !== false && !x.evidence.some((e) => e.key === d.key)) {
          index.push([c.id, x.m.id, x.m.title, d.label, "MISSING", ""]);
          missing++;
        }
      }
    }
  }
  const csv = "﻿" + index.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  archive.append(Buffer.from(csv, "utf8"), { name: `${root}/_index.csv` });
  await archive.finalize();
  return { files: count, missing };
}
