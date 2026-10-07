// Size checks on an uploaded .xlsx (a ZIP archive) before ExcelJS inflates it. ExcelJS reads
// every part fully into memory, so a small upload that expands to gigabytes would exhaust the
// server. Each part is inflated here with a hard output cap; nothing larger is ever allocated.
import { inflateRawSync } from "node:zlib";

/** Total uncompressed bytes allowed across all parts (real workbooks are a few MB). */
export const MAX_XLSX_UNCOMPRESSED = 50 * 1024 * 1024;
export const MAX_XLSX_ENTRIES = 2000;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export class XlsxLimitError extends Error {}

function findEndOfCentralDirectory(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  throw new XlsxLimitError("not a zip archive");
}

/**
 * Throws XlsxLimitError when `buf` is not a plain ZIP, has too many parts, or would inflate to
 * more than `maxTotal` bytes. Sizes declared in the archive are not trusted: every deflated part
 * is actually inflated with `maxOutputLength`, so a lying header cannot get past the cap.
 */
export function assertXlsxWithinLimits(buf: Buffer, maxTotal = MAX_XLSX_UNCOMPRESSED, maxEntries = MAX_XLSX_ENTRIES): void {
  if (buf.length < EOCD_MIN) throw new XlsxLimitError("not a zip archive");
  const eocd = findEndOfCentralDirectory(buf);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers: never needed for a 10 MB upload, so treat them as hostile.
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new XlsxLimitError("zip64 archives are not supported");
  if (entries > maxEntries) throw new XlsxLimitError("too many parts");
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new XlsxLimitError("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) throw new XlsxLimitError("corrupt local header");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw new XlsxLimitError("truncated part");
    const remaining = maxTotal - total;
    let produced: number;
    if (method === 0) {
      produced = compressed;
    } else if (method === 8) {
      try {
        produced = inflateRawSync(buf.subarray(start, start + compressed), { maxOutputLength: remaining + 1 }).length;
      } catch (e) {
        if (e instanceof RangeError) throw new XlsxLimitError("uncompressed size limit exceeded");
        throw new XlsxLimitError("corrupt deflate stream");
      }
    } else {
      throw new XlsxLimitError("unsupported compression method");
    }
    total += produced;
    if (total > maxTotal) throw new XlsxLimitError("uncompressed size limit exceeded");
  }
}
