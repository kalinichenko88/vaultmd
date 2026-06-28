import type { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 1;

// Creates the derived index schema. All statements are IF NOT EXISTS so this is
// safe to call on every boot. notes.id is the stable rowid AND the FTS docid;
// notes_fts is a STANDALONE fts5 table (keeps its own body copy), addressed by
// rowid = notes.id — never INSERT OR REPLACE on notes (that reassigns id and
// orphans the FTS row).
export function applySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL,
      path_key    TEXT NOT NULL UNIQUE,
      mtime_ms    INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      title       TEXT NOT NULL,
      frontmatter TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS note_tags (
      path_key TEXT NOT NULL,
      tag      TEXT NOT NULL,
      PRIMARY KEY (path_key, tag)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS note_links (
      src_key TEXT NOT NULL,
      target  TEXT NOT NULL,
      base    TEXT,
      kind    TEXT NOT NULL,
      PRIMARY KEY (src_key, target, kind)
    )
  `);

  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body)');

  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  db.run('CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag)');
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target)',
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_note_links_base ON note_links(base)');
}
