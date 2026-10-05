// Evidence and export files. Local disk in dev; an S3/R2 implementation can replace it
// without touching services (same interface).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface FileStore {
  put(prefix: string, body: Buffer): Promise<{ key: string; sha256: string; bytes: number }>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const p = resolve(this.root, key);
    // Keys are generated here, but never let a key escape the root folder.
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("invalid file key");
    return p;
  }

  async put(prefix: string, body: Buffer) {
    const sha256 = createHash("sha256").update(body).digest("hex");
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "_");
    const key = join(safePrefix, `${randomUUID()}`).replaceAll("\\", "/");
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
    return { key, sha256, bytes: body.length };
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}
