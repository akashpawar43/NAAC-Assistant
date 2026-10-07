// Deleting an account and everything that belongs only to it.
import type { Db } from "../db/client.js";
import type { FileStore } from "../infra/file-store.js";

/**
 * Deletes the user. Their own workspace (college.owner_id) goes with them, cascading to its
 * reports, rows, narratives, links and evidence records; the evidence files are removed from the
 * store after the database commit. Memberships of and shares in other people's workspaces are
 * removed by the foreign keys; work they did there stays, with the author cleared (SET NULL).
 */
export async function deleteAccount(db: Db, files: FileStore, userId: string): Promise<{ workspaces: number; files: number }> {
  const { keys, workspaces } = await db.tx(async (t) => {
    const owned = (await t.query<{ id: string }>("SELECT id FROM college WHERE owner_id = $1", [userId])).rows.map((r) => r.id);
    const keys = owned.length
      ? (await t.query<{ file_key: string }>("SELECT file_key FROM evidence WHERE college_id = ANY($1::text[])", [owned])).rows.map((r) => r.file_key)
      : [];
    // The audit log has no foreign keys; its rows for the deleted workspace describe deleted data.
    if (owned.length) await t.query("DELETE FROM audit_log WHERE college_id = ANY($1::text[])", [owned]);
    await t.query("DELETE FROM app_user WHERE id = $1", [userId]);
    return { keys, workspaces: owned.length };
  });
  for (const k of keys) await files.delete(k);
  return { workspaces, files: keys.length };
}
