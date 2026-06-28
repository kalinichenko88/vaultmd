# mdvault

Headless markdown-vault data layer for Bun — CRUD over `.md` notes plus a
derived SQLite index (collection queries, backlinks, keyword search). No
Obsidian, no plugin, no Electron. The `.md` files on disk are the source of
truth; the index is a rebuildable cache.

## Status

`mdvault` provides a headless markdown-vault data layer: CRUD over `.md`
notes plus a derived `bun:sqlite` index (collection queries, backlinks,
keyword search), with the `.md` files as the source of truth and the index a
rebuildable cache. No Obsidian.

Primary entry point — the `createVault` composition root:

```ts
import { createVault } from 'mdvault';

const vault = await createVault({
  root: '/path/to/vault',
  prefixes: { read: [''], write: ['Notes/'] },
  indexPath: './data/vault-index.db', // in DATA_DIR, NOT the vault
});

const hits = vault.query.queryNotes({ tag: 'project', limit: 20 });
await vault.notes.updateNote('Notes/today.md', { append: '\n- done' });
vault.close();
```

Lower-level primitives (`createVaultIo`, `withFileTransform`, `parseFrontmatter`,
`storedLinksFor`, …) are also exported for advanced use.

The index db and its `-wal`/`-shm` sidecars must be gitignored and kept out of
the synced vault.

## License

MIT — generic vault mechanics only; domain/persona/sync logic lives in the
consuming applications.
