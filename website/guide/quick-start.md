# Quick start

Install VaultMD, open a vault, write a note, and read it back — the whole loop
in one file. For what the pieces mean, read [Concepts](./concepts) next.

## Install

```bash
bun add vaultmd
```

Requires [Bun](https://bun.sh) ≥ 1.3.14. VaultMD uses `bun:sqlite`, `Bun.file`
and other Bun built-ins — it does **not** run under Node.

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
it.

Every option above is documented on
[`CreateVaultConfig`](/api/type-aliases/CreateVaultConfig), and what
`createVault` hands back on [`Vault`](/api/type-aliases/Vault) —
[`vault.notes`](/api/type-aliases/NotesApi) for writes,
[`vault.query`](/api/type-aliases/QueryApi) for reads.
