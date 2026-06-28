# Quick start

## Install

```bash
bun add vaultmd
```

## Open a vault

```ts
import { createVault } from 'vaultmd';

const vault = await createVault({
  root: '/path/to/vault',
  // Read everything, but only write under Notes/.
  prefixes: { read: [''], write: ['Notes/'] },
  // Keep the index db outside the synced vault.
  indexPath: './data/vault-index.db',
});

await vault.notes.createNote('Notes/ideas/first.md', {
  frontmatter: { tags: ['idea'] },
  body: '# First\n\nLinking to [[Notes/ideas/second]].',
});

const hits = vault.query.queryNotes({ tag: 'idea' });
console.log(hits.map((h) => h.path));

vault.close();
```

The `.md` file on disk is the source of truth; the SQLite index is rebuilt from
it. See [Concepts](./concepts) for how that works, and the
[API Reference](/api/) for the full surface.
