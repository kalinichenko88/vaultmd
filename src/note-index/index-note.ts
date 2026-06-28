import type { Database } from 'bun:sqlite';

import { parseFrontmatter } from '@/frontmatter/index.ts';
import type { Sig } from '@/fs-atomic/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

import type { IndexConfig } from './models/index-config.ts';
import { projectRow } from './project.ts';

export function indexNote(
  db: Database,
  vaultIo: Pick<VaultIo, 'toVaultRelative' | 'toKey'>,
  cfg: IndexConfig,
  rel: string,
  content: string,
  sig: Sig,
): void {
  const row = projectRow(content, rel, vaultIo, cfg);
  const body = parseFrontmatter(content).body; // FTS indexes note text, not the YAML block

  const tx = db.transaction(() => {
    const existing = db
      .query('SELECT id FROM notes WHERE path_key = ?')
      .get(row.pathKey) as { id: number } | null;

    let id: number;
    if (existing) {
      // UPDATE in place — keep notes.id (the FTS docid) STABLE; never INSERT OR REPLACE
      id = existing.id;
      db.query(
        'UPDATE notes SET path = ?, mtime_ms = ?, size = ?, title = ?, frontmatter = ? WHERE id = ?',
      ).run(
        row.path,
        sig.mtimeMs,
        sig.size,
        row.title,
        row.frontmatterJson,
        id,
      );
      db.query('DELETE FROM notes_fts WHERE rowid = ?').run(id);
    } else {
      const res = db
        .query(
          'INSERT INTO notes(path, path_key, mtime_ms, size, title, frontmatter) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          row.path,
          row.pathKey,
          sig.mtimeMs,
          sig.size,
          row.title,
          row.frontmatterJson,
        );
      id = Number(res.lastInsertRowid);
    }
    // re-insert the FTS body under the (stable) rowid for both create and update
    db.query('INSERT INTO notes_fts(rowid, body) VALUES (?, ?)').run(id, body);

    // tags: replace-by-key; PK + OR IGNORE collapses duplicates within the note
    db.query('DELETE FROM note_tags WHERE path_key = ?').run(row.pathKey);
    const insertTag = db.query(
      'INSERT OR IGNORE INTO note_tags(path_key, tag) VALUES (?, ?)',
    );
    for (const tag of row.tags) {
      insertTag.run(row.pathKey, tag);
    }

    // links: replace-by-key; PK (src_key, target, kind) keeps edges distinct
    db.query('DELETE FROM note_links WHERE src_key = ?').run(row.pathKey);
    const insertLink = db.query(
      'INSERT OR IGNORE INTO note_links(src_key, target, base, kind) VALUES (?, ?, ?, ?)',
    );
    for (const link of row.links) {
      insertLink.run(row.pathKey, link.target, link.base, link.kind);
    }
  });

  tx();
}

export function dropNote(db: Database, pathKey: string): void {
  const tx = db.transaction(() => {
    const existing = db
      .query('SELECT id FROM notes WHERE path_key = ?')
      .get(pathKey) as { id: number } | null;
    if (existing) {
      db.query('DELETE FROM notes_fts WHERE rowid = ?').run(existing.id);
    }
    db.query('DELETE FROM notes WHERE path_key = ?').run(pathKey);
    db.query('DELETE FROM note_tags WHERE path_key = ?').run(pathKey);
    db.query('DELETE FROM note_links WHERE src_key = ?').run(pathKey);
  });

  tx();
}
