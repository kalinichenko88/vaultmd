import type { Database } from 'bun:sqlite';

import { readConsistent, type Sig, statSig } from '../fs-atomic/index.ts';
import type { VaultIo } from '../vault-io/index.ts';

import { dropNote, indexNote } from './index-note.ts';
import type { IndexConfig } from './models/index-config.ts';
import type { Reconciler } from './models/reconciler.ts';
import { configFingerprint, writeMeta } from './open.ts';
import { SCHEMA_VERSION } from './schema.ts';

type StoredRow = {
  path_key: string;
  path: string;
  mtime_ms: number;
  size: number;
};

export function createReconciler(
  db: Database,
  vaultIo: VaultIo,
  cfg: IndexConfig,
): Reconciler {
  function storedSigs(): Map<string, Sig> {
    const rows = db
      .query('SELECT path_key, path, mtime_ms, size FROM notes')
      .all() as StoredRow[];
    const stored = new Map<string, Sig>();
    for (const row of rows) {
      if (!vaultIo.can(row.path, 'read')) {
        continue; // out-of-scope row: never inspected, never dropped
      }
      stored.set(row.path_key, { mtimeMs: row.mtime_ms, size: row.size });
    }

    return stored;
  }

  async function reconcile(): Promise<void> {
    const rels = await vaultIo.listMarkdown();
    const stored = storedSigs();
    const onDisk = await Promise.all(
      rels.map(async (rel) => {
        const full = vaultIo.resolveVaultPath(rel, 'read');
        const sig = await statSig(full);

        return { rel, key: vaultIo.toKey(rel), full, sig };
      }),
    );
    const seen = new Set<string>();
    for (const entry of onDisk) {
      if (entry.sig === null) {
        continue;
      }
      seen.add(entry.key);
      const prev = stored.get(entry.key);
      if (
        prev &&
        prev.mtimeMs === entry.sig.mtimeMs &&
        prev.size === entry.sig.size
      ) {
        continue;
      }
      const read = await readConsistent(entry.full);
      if (read.content === null || read.sig === null) {
        continue;
      }
      indexNote(db, vaultIo, cfg, entry.rel, read.content, read.sig);
    }
    for (const key of stored.keys()) {
      if (!seen.has(key)) {
        dropNote(db, key);
      }
    }
  }

  async function reconcilePaths(rels: string[]): Promise<void> {
    for (const rel of rels) {
      if (!vaultIo.can(rel, 'read')) {
        continue;
      }
      const key = vaultIo.toKey(rel);
      let full: string;
      try {
        full = vaultIo.resolveVaultPath(rel, 'read');
      } catch {
        dropNote(db, key); // unresolvable target -> drop by syntactic key
        continue;
      }
      const read = await readConsistent(full);
      if (read.content === null || read.sig === null) {
        dropNote(db, key); // gone on disk -> drop by syntactic key (no realpath needed)
        continue;
      }
      indexNote(db, vaultIo, cfg, rel, read.content, read.sig);
    }
  }

  async function rebuild(): Promise<void> {
    const rels = await vaultIo.listMarkdown();
    const items = (
      await Promise.all(
        rels.map(async (rel) => {
          const full = vaultIo.resolveVaultPath(rel, 'read');
          const read = await readConsistent(full);
          if (read.content === null || read.sig === null) {
            return null;
          }

          return { rel, content: read.content, sig: read.sig };
        }),
      )
    ).filter(
      (item): item is { rel: string; content: string; sig: Sig } =>
        item !== null,
    );

    const swap = db.transaction(() => {
      const rows = db.query('SELECT id, path_key, path FROM notes').all() as {
        id: number;
        path_key: string;
        path: string;
      }[];
      const delNote = db.query('DELETE FROM notes WHERE id = ?');
      const delFts = db.query('DELETE FROM notes_fts WHERE rowid = ?');
      const delTags = db.query('DELETE FROM note_tags WHERE path_key = ?');
      const delLinks = db.query('DELETE FROM note_links WHERE src_key = ?');
      for (const row of rows) {
        if (!vaultIo.can(row.path, 'read')) {
          continue; // out-of-scope row: survives the rebuild swap
        }
        delFts.run(row.id);
        delNote.run(row.id);
        delTags.run(row.path_key);
        delLinks.run(row.path_key);
      }
      for (const item of items) {
        indexNote(db, vaultIo, cfg, item.rel, item.content, item.sig);
      }
      writeMeta(db, 'config_fingerprint', configFingerprint(cfg));
      writeMeta(db, 'schema_version', String(SCHEMA_VERSION));
    });
    swap();
  }

  return { reconcile, reconcilePaths, rebuild };
}
