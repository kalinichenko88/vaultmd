# Changelog

## 0.11.0 — 2026-08-30

Notes become addressable by heading: read or replace one section of a note
without touching the rest. Attachments become readable as bytes. And the
`vault-io` chokepoint now refuses hidden state (`.env`, `.git`, `.obsidian`) on
*every* path through it, not just one. **The index schema bumps 2 → 3, so the
first boot on an existing index rebuilds it** (automatic, and only for an
instance that owns the whole index). Public API grows 51 → 53 names. Bun floor
unchanged at ≥ 1.3.14.

### Security

- **Hidden state was reachable through most of `vault-io`.** The dot-segment
  guard lived at one call site, so `readVaultFile('.obsidian/secret.md')`,
  `stat()`, `writeVaultFile('.obsidian/pwned.md')`, and a symlink aliasing a
  visible `.md` name onto `.env` all went through. The check — on the requested
  path *and* on the symlink-resolved target — now lives in `resolveCanonical`,
  the gate every path-taking member already shares, so it covers `readVaultFile`,
  `writeVaultFile`, `rewriteIfUnchanged`, `unlinkIfUnchanged`, `stat`,
  `readBinary`, and the enumeration walk at once. `listFolders` judged a
  directory by its link name, so `ln -s .obsidian notes` leaked the hidden tree's
  shape; it now resolves first. `can()` — the only scope filter `query` has —
  answers the hidden rule too, so a `.secret.md` indexed by an older version is
  no longer queryable. A hidden prefix is rejected by `canonPrefix`, where the
  configuration is made rather than on every use.

### Breaking

- **Index rebuild on upgrade.** `SCHEMA_VERSION` is now `3`: titles are derived
  by the shared heading scanner, which resolves fenced code correctly, so
  existing rows can disagree with disk. A scoped instance that does *not* own the
  whole index throws `INDEX_UNAVAILABLE` rather than rebuilding a shared index
  out from under another scope — boot an owning instance once to repair it.
- **Links inside a mismatched code fence are no longer extracted.** A fence
  opened with ``` and closed with ~~~ (or vice versa) stays open per CommonMark;
  links in that region were previously indexed and now are not, so a backlink
  that only ever existed inside such a block disappears.
- **A root-level dotfile (`.secret.md`) is no longer listed or readable.**
  Dot-*folders* were already skipped by the walk; dot-*files* were not.

### Heading and section addressing

- **`readSection(path, heading)`** returns one section's body — everything under
  an ATX heading up to the next heading of the same or shallower level.
- **`setSection`**, a new `updateNote` op, replaces that same span. Guarded:
  the payload cannot smuggle in a heading that collides with one already in the
  note, cannot open an unclosed fence, and cannot end in a setext underline —
  each of which would leave the caller locked out of their own section with
  `AMBIGUOUS_MATCH`. A section whose span has no defined end (it runs into an
  unterminated fence, i.e. the rest of the file) is refused with
  `VALIDATION_ERROR` rather than silently replaced.
- **`extractHeadings(body)` and the `Heading` type are now public**, so you can
  scan a note's headings and section spans without a round-trip through `notes`.
- Round-trips are byte-identical: `setSection(h, readSection(h))` rewrites
  nothing and does not move the file's mtime — CRLF files and trailing newlines
  included.

### Attachment reads

- **`vault.io.readBinary(rel)`** returns the raw bytes of any vault file —
  images, PDFs, audio — as a `Uint8Array`, or `null` if it is absent. It lifts
  the `.md` requirement and nothing else: canonicalization, the read allowlist,
  `..`-escape rejection, symlink containment, and the hidden-path rule all still
  run. A directory reads as absent rather than throwing. Read-only and
  unindexed by design — an attachment has no frontmatter, no links, and no body
  to search.

### Fixes

- **A list closed by `---` is a valid note again.** `notes` treated every
  non-blank preceding line as a paragraph, so any `---`/`===` after one read as
  a setext underline and the note was refused outright. CommonMark only makes it
  a heading after a *paragraph* — after a list item, a block quote, or a
  thematic break, the same line is an ordinary horizontal rule. The other
  direction closed too: `===` and `--` are too short to be thematic breaks, so
  they *are* paragraphs that a following `---` really does underline.
- **No more YAML warning on stderr for an unrendered template placeholder.** A
  `created: {{DATE:...}}` left behind by Obsidian/Templater parses as a mapping
  used as a map key, and `yaml` printed advice on every parse that the consuming
  app could not act on. The shape was already reported through
  `FrontmatterValidity: 'nested'`. Warnings are suppressed; errors still throw,
  so a genuinely invalid block still earns `'present-but-invalid'`.

### Docs

- The site's navigation is reworked around four journeys — Getting started,
  Concepts, Recipes, API — with the guide and generated API sidebars linking
  both ways, plus a sharper homepage and cross-links from every guide page to
  the API pages for the types it names.
- Corrected when the index actually rebuilds: ordinary drift is picked up by
  incremental reconcile, not a rebuild.

## 0.10.0 — 2026-08-02

A note whose frontmatter nests is no longer second-class: it is read, indexed,
and queryable, while everything this package *writes* stays flat. Plus
`listFolders()`, the folder counterpart to `listMarkdown()`. **The index schema
bumps 1 → 2, so the first boot on an existing index rebuilds it** (automatic,
and only for an instance that owns the whole index — see the note below). Public
API freeze stays at 51 names. Bun floor unchanged at ≥ 1.3.14.

### Breaking

- **`FrontmatterValidity` gains a fourth member, `'nested'`.** An exhaustive
  `switch` over it needs a new arm. `=== 'flat'` keeps exactly its old meaning —
  "safe to pass to `editFrontmatter`" — so a check written that way is unaffected.
- **Index rebuild on upgrade.** `SCHEMA_VERSION` is now `2`, because a
  present-but-nested note projects differently than it did. `reconcile` skips a
  file whose mtime and size are unchanged, so without the bump an existing index
  would keep its stale rows forever. A scoped instance that does *not* own the
  whole index throws `INDEX_UNAVAILABLE` rather than rebuilding a shared index
  out from under another scope — boot an owning instance once to repair it.

### Nested frontmatter: flat writes, nested reads

The two gates are now separate, because they were never the same question:

- **Reads widened.** A block with a map or an array-of-maps value now reports
  `valid: 'nested'`, returns its keys, and is indexed — so it answers tag,
  `where`, and search queries like any other note, and you can read the nested
  value off `NoteHit.frontmatter`. Previously such a note lost its frontmatter
  entirely: one nested key cost it its tags and its title, and it dropped out of
  every query.
- **Writes unchanged and still flat.** `serializeFrontmatter`, `createNote`, and
  `editFrontmatter` accept scalars and arrays of scalars only. `editFrontmatter`
  refuses a `'nested'` note *before* invoking your mutator, so the callback never
  runs against a block that cannot be rewritten a key at a time. This package
  never authors a shape it could not then edit.
- **`where` filters top-level keys only.** Reaching into a nested value is done
  by reading `NoteHit.frontmatter`, not by the filter — a dotted key like
  `'meta.status'` still matches a frontmatter key that literally contains a dot,
  as it always has. The unknown-operator error now says so instead of suggesting
  a path syntax.
- **Only genuinely unstorable blocks come back empty** (`'present-but-invalid'`):
  unparseable YAML, a non-map root, a YAML-anchor cycle, a non-finite number, or
  nesting deep enough to overflow the serializer.
- A shared YAML anchor is handled rather than mishandled: a note that anchors a
  container and aliases it elsewhere parses and indexes normally, and only an
  *edit* that would orphan the anchor is refused — with a proper
  `FRONTMATTER_INVALID`, not a raw uncoded `Error`.

### Folder enumeration

- **`vaultIo.listFolders()`** returns every folder in the read scope, sorted.
  Consumers building a tree previously split `listMarkdown()` paths on `/` and
  deduped, which never sees a folder holding no markdown. Empty folders *are*
  listed, matching Obsidian's `Vault.getAllFolders`. Folders pass the same guards
  as files: read allowlist, dot-folder skip, `ignore` globs, symlink containment.
- **Fixed: enumeration recursed through symlink cycles.** A directory symlink
  aimed at its own ancestor (`ln -s .. vault/notes/loop`) stays inside the root,
  so containment let it through and the walk re-enumerated the vault under an
  aliased path at every level until the kernel's symlink limit stopped it. On a
  two-entry vault that yielded 32 `.md` paths for a single note — and since
  `reconcile` feeds `listMarkdown()` into the index, each alias became a phantom
  row. Pre-existing in `listMarkdown`; `listFolders` made it visible.

### Fixed

- **A malformed note no longer aborts the whole reconcile sweep.** The
  values-invalid branch of `parseFrontmatter` handed back the real parsed object,
  which for a block built from YAML anchors can be cyclic; `projectRow`
  stringified it and threw a raw `TypeError` out of `indexNote`. Because the lazy
  sweep is fire-and-forget, that silently left every note after it in scan order
  unindexed.
- **`INDEX_UNAVAILABLE` now names which trigger fired** — a stale schema version
  or an `IndexConfig` disagreement — lists the read prefixes that make the
  instance a non-owner, and says what to do. The two call for different actions
  and the message always blamed the second.

### Performance

- **`queryNotes` builds a `NoteHit` only for the page it returns.** It previously
  parsed every matching row's frontmatter and ran a tag lookup per note *before*
  slicing, so `limit: 20` over a 5,000-note vault did that work 5,000 times and
  discarded 4,980. Measured on 5,000 notes with ~1 KB of nested frontmatter each:
  **20.4 ms → 5.9 ms** per call.

## 0.9.0 — 2026-08-01

`reconcile()` stops returning `void` and starts reporting what it changed — the
missing half of `onCommit`, which only ever saw this instance's own writes. No
schema change, so no index rebuild is triggered. Public API freeze goes 50 → 51
names (`ReconcileResult`). Bun floor unchanged at ≥ 1.3.14.

### Reconcile as a change feed

- **`vault.reconcile()` now resolves to `{ added, updated, removed }`** — sorted
  vault-relative paths — instead of `void`. The sweep already computed that set
  to decide what to write, so it is a watcher-free change feed for free: poll it
  to pick up edits made in an editor, by `git checkout`, or by a sync client.
- **Every sweep's result is buffered, not only the one you awaited.** With
  `lazyReconcile` on (the default) a background sweep fired by a read would
  index an out-of-band edit, and the next explicit `reconcile()` — finding
  (mtime, size) already in step — would report nothing. Sweeps now fold their
  results into one pending set that `reconcile()` drains, so the paths returned
  cover everything since the caller's last call, whichever sweep reached them
  first.
- **Explicit and lazy sweeps are now serialised against each other.** Previously
  only lazy sweeps were guarded between themselves, so an explicit `reconcile()`
  could run concurrently with one, each snapshotting the index before the
  other's writes landed.
- Merging is per path, so a change never lands in two buckets: added-then-
  updated stays `added`, added-then-removed cancels. Known ceiling: a file
  created *and* deleted between two polls is reported as `removed` for a path
  the consumer never saw.
- `reconcilePaths()` and `rebuild()` still return `void` — the caller already
  named the paths there, so there is nothing to discover.
- **`onCommit` is not a change feed**, and now says so in its TSDoc, the README,
  and the concepts guide. It fires from the locked-file commit path, so it
  reports only writes made through this vault instance — the name read like more
  than it delivered.

### Docs

- The site now lives at **<https://vaultmd.kalinichenko.dev/>**; the package
  `homepage` and the README links follow it.
- New recipe: **renaming a tag across the whole vault**. Bulk `retag()` stays a
  non-goal, so the answer lives where consumers actually read instead. It reuses
  the package's own `deriveTags` on the read side, so `tags` vs `tag`, comma- or
  space-separated strings and `#` prefixes all behave as the index does; it
  collects the paths before writing, since a rename drops the note out of
  `tag: from` and paginating mid-mutation would skip matches; and it surfaces
  notes whose frontmatter isn't flat rather than forcing a write through them.

## 0.8.0 — 2026-07-30

Two independent unblocks for consumers writing a vault programmatically: a
relevance number on every search hit, and frontmatter that stops folding long
values across lines. No schema change, so no index rebuild is triggered, and the
public API freeze stays at 50 names — `SearchHit` gains a *member*, not the
surface a name. Bun floor unchanged at ≥ 1.3.14.

### Search relevance

- **`query.searchText()` hits now carry `score`** — the relevance fts5 was
  already computing to order them by, and the query then threw away. Rank
  *order* alone cannot separate a strong match from the least-bad match in a
  vault where nothing really matches, which is exactly what a caller asking "is
  this the note I am about to write?" needs a number for.
- **Higher is better.** fts5 ranks with `bm25()`, which returns a *negative*
  number where more negative is the better match (hence its ascending rank
  order). The exported `score` is that value negated, so a threshold reads
  `score > x` instead of the `score < -x` every caller gets backwards at least
  once. Result order is unchanged — hits still arrive best first, and `hits[0]`
  is now also `max(score)`.
- **Comparable only within one query's results.** BM25 weighs a term by how rare
  it is across the vault and how short the matching note is, so the same number
  means different things for different query strings, and a threshold tuned on
  one query does not transfer to another. For the same reason a fixed cutoff
  drifts as the vault grows, and a read-scoped instance is ranked against the
  whole index rather than the subset it can read. Compare hits against each
  other, or against the top hit — not against a constant carried between
  searches. The TSDoc says all of this at the field, where a consumer picking a
  cutoff will read it.
- The field carries **only on `searchText()`**. The mention methods match a
  note's *names* in prose rather than running one ranked query, so any number
  attached to them would be per-name (a hit found via an alias not comparable
  with one found via the filename), unordered, and simply missing for a name
  fts5 cannot tokenize (`📥.md`) — none of the properties above. They return
  hits with no `score` key at all rather than a number that fails every
  guarantee the field makes.
- `countSearch()` is unaffected: it shares the same statement with the snippet
  projection off, and still counts precisely the rows `searchText` returns.

### Fixed

- **Frontmatter folded any scalar past 80 characters** onto indented
  continuation lines — yaml's default `lineWidth`. The value still survived a
  parse round-trip, but a long `source:` provenance string or URL landed on disk
  unreadable to anything treating the file as line-oriented text, breaking the
  flat single-line frontmatter an agent writing notes continuously depends on.
  Folding is now off (`lineWidth: 0`) on **both** producers — `createNote` /
  `serializeFrontmatter`'s fresh block *and* `editFrontmatter`'s existing-block
  path, which is the commoner write by far since it covers every update to a
  note that already has frontmatter. A value that *contains* a newline still
  spans lines, since it has to carry them; the guarantee is about a column
  limit, not about newlines in the data.
- **`editFrontmatter()` silently lost a trailing newline.** Its existing-block
  path emitted yaml's default `|`/`|+` block scalars, and a `|+` scalar as the
  last key is ambiguous against the closing `---` fence: `note: 'a\n\n'` was
  written, then read back as `'a\n'`, on every round-trip. It now shares
  `serializeFrontmatter`'s `blockQuote: false`, which is exactly what that
  option has always been there to prevent. Cost: an author-written `|` block is
  re-emitted as a double-quoted scalar the first time the note is edited —
  styling traded for the value surviving.
- **`editFrontmatter()` silently dropped an edit to a duplicated key.** YAML
  here is parsed with `uniqueKeys: false` and every reader is last-wins, but
  `doc.set`/`doc.delete` address the *first* pair — so on a note carrying
  `tags:` twice, setting `tags` wrote into a shadowed copy nothing reads (the
  value vanished on the next parse while the outcome still said `'edited'`), and
  deleting `tags` left it in the file. Shadowed pairs are now dropped before the
  mutation, on the edited path only — an unchanged note is still returned
  byte-for-byte.
- Both frontmatter producers now emit through **one shared function**. The fold
  bug existed because they had drifted — one passed explicit options, the other
  used a bare `String(doc)` — and two hand-written `---` fence assemblies plus
  two different trailing-newline strips were the rest of that divergence.

## 0.7.0 — 2026-07-29

Two bodies of query work: richer filtering on every read (#8), and three
read-only `QueryApi` methods closing the link-graph gaps (#10), modelled on
Obsidian so a UI built here behaves the way users already expect. No schema
change, so no index rebuild is triggered. Public API freeze goes 46 → 50 names
(`NoteFilter`, `TagFilter`, `WhereCondition`, `WhereValue`).

**Now requires Bun ≥ 1.3.14** (was ≥ 1.1.0) — the mention matcher uses
`RegExp.escape` rather than a hand-rolled escaper.

### Richer filters

- **`where` values accept an operator object** alongside the existing scalar
  equality: `ne`, `lt`, `lte`, `gt`, `gte`, `in` and `exists`, all AND-ed within
  a key and across keys. `{ in: [] }` is the way to match nothing; an operator
  object contributing no predicate at all (`{}`, or `{ lt: x }` where `x` came
  in `undefined`) throws rather than quietly dropping the entry and returning
  the whole vault. Operands are type-checked and stay bound parameters, so a
  malformed filter errors as a `MdVaultError` with a `.code` instead of
  widening, inverting, or silently matching nothing.
- **`tags: { all, any }`** joins the singular `tag` as the plural form.
- Both land in the shared filter builder, so `queryNotes`, `countNotes`,
  `searchText` and `countSearch` pick them up together — `searchText` and
  `countSearch` now *declare* `where`, which the builder they call had already
  been applying through an undeclared path.
- The `{ tag, tags, where, folder }` bag was hand-written at ten call sites and
  had already diverged; it is now the exported **`NoteFilter`** type, which
  every filtering method takes.
- `ne` is `IS NOT`, not `!=`: `json_extract` yields `NULL` for a field a note
  never sets, so "status is not done" includes a note with no `status` — add
  `exists: true` to require the field. Likewise `ne` against a type-mismatched
  operand matches every row, SQLite holding differing types to be never equal.
  Both are now documented rather than left to be discovered.

### Link graph

- **`query.orphanNotes()`** — notes with no place in the link graph, taking the
  same `NoteFilter`, ordering and pagination as `queryNotes`. Defaults to
  `mode: 'disconnected'`, Obsidian's graph "Orphans" filter (no links in either
  direction); `mode: 'unreferenced'` is the wider set of notes nothing links
  *to*, whatever they link out to. A link naming an attachment is not a graph
  edge, so a note carrying only those is still an orphan; a link that resolves
  to nothing still counts as an outgoing edge, matching the ghost nodes
  Obsidian draws. An unknown `mode` throws `VALIDATION_ERROR` rather than
  quietly answering a different question.
- **`query.unlinkedMentions(path)`** — notes that name this one in prose
  without linking it: Obsidian's "Unlinked mentions" in the Backlinks pane, and
  the prose counterpart of `backlinks()`.
- **`query.outboundMentions(path)`** — notes named in *this* note's body
  without being linked from it: the same feature in Obsidian's Outgoing links
  pane, and the prose counterpart of `outboundLinks()`. Ordered by where each
  mention falls in the body, so hits arrive in reading order.

Both mention methods match a note's **filename, its explicit frontmatter
`title`, and its `aliases`** — not the derived title, which falls back to the
first `#` heading and would turn every note headed "Overview" into a mention of
that word. Matching is case-insensitive and needs a word boundary, so `cat` is
never found inside `catalogue`, and it is Unicode-aware, so Cyrillic and other
non-Latin names match. A note that already links is reported by `backlinks` /
`outboundLinks`, never as a mention.

Text sitting inside link markup is not prose: `[[Alpha Notes]]` is not reported
as an unlinked mention of `Alpha`, and neither is the visible text of a
markdown link. A name made only of symbols (`→.md`, an emoji inbox note) is
found too, even though FTS5 cannot index it.

**Known limitation:** a name embedded in unsegmented text — Chinese and
Japanese prose, written without spaces — is not found, because there is no word
boundary to match; only space- or punctuation-delimited occurrences are.
Obsidian finds those. Closing the gap needs a different FTS5 tokenizer, which
is an index-schema change and so its own release.

### Fixed

- **`query.backlinks()` missed real backlinks on a case-insensitive vault.** It
  resolved the reverse direction its own way instead of inverting the resolver
  `outboundLinks` uses, and disagreed with it twice: a bare `[[Alpha]]` was
  dropped unless the caller spelled the path exactly as the index stores it
  (`backlinks('alpha.md')` found nothing for `Alpha.md`), and in
  `linkResolution: 'relative'` a link whose stored target differed in case from
  the folded path key matched nothing at all. Both directions now share one
  resolution rule, so they cannot drift again.
- **`query.backlinks()` threw on an out-of-scope path with invalid
  pagination** where `outboundLinks` returned `[]` for the same inputs. The
  scope check runs first again, as it did before.

### Docs

- A **bulk-import recipe** (#9) for loading many notes at once: a bounded pool
  over `createNote` roughly halves the wall-clock against a serial loop, since
  the filesystem syscalls dominate and distinct paths never contend for a lock.
  It collects per-entry failures so one bad note cannot sink the run, and warns
  about `EMFILE` on an unbounded `Promise.all`. No new API — the existing one
  already covers it.

## 0.6.0 — 2026-07-29

Five additions closing the gaps the 1.0 surface implied but could not serve.
Public API freeze goes 45 → 46 names (`DanglingLink`).

- **`notes.exists(path)`** — a non-throwing presence probe, turning
  create-or-update from a `try`/`catch` on `ALREADY_EXISTS` into a plain branch.
  Checked against the READ allowlist, so an unreadable or non-`.md` path still
  throws (`ALLOWLIST_VIOLATION` / `NOT_MARKDOWN`) — that is a caller bug, not an
  absent note. Every other stat failure answers `false`, and a *directory* named
  `x.md` answers `false` rather than sending the documented recipe down the
  update path.
- **`query.danglingLinks()`** — the vault-wide sweep for links that resolve to
  no note, returning `{ from, target }[]` ordered by source path then target.
  `moveNote` deliberately never rewrites inbound links, and until now the only
  way to find the fallout was `outboundLinks()` over every note. Links naming an
  attachment file type (`[[diagram.png]]`, `![[notes.pdf]]`, embedded or not)
  are excluded — they can never resolve to a `.md` note, so they are not
  breakage. This makes it stricter than `outboundLinks`, which reports raw
  resolution and still returns `resolved: null` for those same links; both
  TSDocs now say so and point at each other. A note carrying both `[[ghost]]`
  and `![[ghost]]` reports one row, not two, as `backlinks` already did.
- **`query.countNotes()` / `query.countSearch()`** — the uncapped totals for the
  same filters `queryNotes` and `searchText` take, so
  `Math.ceil(countNotes(f) / pageSize)` is exact. Read-scope filtering happens
  in JS after the scan, so callers had no cheap way to compute a page count
  themselves.
- **`NoteHit` now carries `mtime_ms` and `size`** — the values already sitting
  in the index. `queryNotes` could sort on `mtime_ms` but never returned it, so
  any "recently changed" list needed an extra `vault.io.stat()` per row.
- **`updateNote` gains `prepend` and `setBody`** — `prepend` inserts at the
  start of the BODY (after the frontmatter block, never above it) and creates
  the note when absent; `setBody` replaces the body wholesale, keeps the
  frontmatter verbatim, and refuses to create a missing note
  (`REFUSE_CREATE`). Both share `append`'s guard against welding text onto a
  closing fence.
- Internals are shared rather than re-copied: `buildNoteFilters` backs
  `queryNotes` / `countNotes` / `searchText`, and `resolveLinkTarget` backs
  `outboundLinks` / `danglingLinks`, so a link cannot count as resolved in one
  and dangling in the other.
- Chores: bumped biome and typedoc, and moved the release workflow's Node pin to
  24 (`actions/setup-node@v7`).

## 0.5.0 — 2026-07-21

- **`notes.moveNote(from, to)`** — relocate a note to a new vault-relative path
  as one atomic operation, instead of assembling it consumer-side from
  `createNote` + `deleteNote` (which leaves a duplicate note in the source of
  truth if the process dies between the two steps, and forces callers to hold
  `deleteNote` they may not want). Content moves byte-for-byte with its
  frontmatter untouched, and the index row follows the file in the same lock.
  Both ends go through the `vault-io` chokepoint, so containment, the write
  allowlist and the `.md` requirement are enforced on the destination too — not
  only the source. Throws `NOT_FOUND` for a missing source, `ALREADY_EXISTS`
  for an occupied destination (never clobbers, source left in place),
  `VALIDATION_ERROR` when both paths resolve to the same note, and
  `MTIME_CONFLICT` if the source changes mid-move — in which case the freshly
  created destination is rolled back, so a failed move never leaves the
  duplicate it exists to prevent.
- **`withFileMove` + `MoveTarget`** — the `locked-file` primitive behind it, now
  public alongside `withFileTransform` / `withFileDelete`. It takes **both**
  per-file locks in sorted key order (in-process inside cross-process, as
  before), so two opposing moves — `a → b` and `b → a` — can never deadlock.
- On success the move emits two commit events, `delete` then `create`, rather
  than a new `move` variant: the pair describes the same observable end state,
  so existing `onCommit` consumers and write-through indexing need no changes.

## 0.4.1 — 2026-07-16

- **Internal cleanup only — no API or behavior changes.** Removed a handful of
  hand-rolled reimplementations of standard-library/Bun helpers and single-use
  wrappers across `notes`, `query`, and `locks`: exact-match counting in
  `updateNote` now uses `String.split`, the bare-wikilink candidate lookup shared
  by `backlinks` and `outboundLinks` was de-duplicated into one helper, and the
  cross-process lock's retry delay now uses `Bun.sleep`. The frozen public
  surface is unchanged.

## 0.4.0 — 2026-06-30

- **`query.tags()`** — a new read-only query returning the vault's existing tags
  as `{ tag, count }[]`, ranked most-used first, so callers can reuse and extend
  tags instead of inventing duplicates. Optional filters: `prefix` (case-sensitive
  hierarchy navigation, e.g. `project/`), `contains` (ASCII case-insensitive
  substring search), `folder` (restrict to a folder subtree), and `limit` (top-N).
  Results are read-scope filtered like every other query, and `count` reflects
  only the notes the instance is allowed to read.
- **`TagInfo`** — the `{ tag: string; count: number }` shape `query.tags()`
  returns, added to the public API.
- **`query` folder filter** now treats `%` and `_` in a folder name as literal
  characters instead of SQL `LIKE` wildcards — `queryNotes`, `searchText`, and
  `tags` with a `folder` such as `foo_1` no longer over-match unrelated paths.

## 0.3.0 — 2026-06-29

- **`serializeFrontmatter`** — the inverse of `parseFrontmatter`: converts a
  flat frontmatter map to a fenced YAML block (`---\n…\n---\n`), or the empty
  string for an empty map. Output is byte-identical to the fresh block
  `createNote`/`editFrontmatter` write to a note with no existing frontmatter
  (an existing block's styling is preserved by `editFrontmatter`, not reproduced
  here). Every accepted input round-trips, including multi-line strings. Throws
  `MdVaultError('FRONTMATTER_INVALID')`, naming the offending keys, on input that
  cannot round-trip — nested objects, arrays of non-scalars, `Date`s, or
  non-finite numbers (`NaN`, `Infinity`). Non-empty arrays serialize as YAML
  block sequences (Obsidian-style `- item` lines, not flow `[a, b]`).
- **`isFlatFrontmatter`** now treats `Date`s and non-finite numbers (`NaN`,
  `Infinity`) as non-flat, since neither survives a serialize/parse round-trip.
  `createNote`/`editFrontmatter` therefore reject those frontmatter values
  instead of silently storing a lossy string.

## 0.2.0 — 2026-06-29

- **Public types** — `Backlink` and `OutboundLink` are now exported from the
  package root, and the `vault.notes` / `vault.query` bundles have named
  interfaces `NotesApi` / `QueryApi` (previously inferred). Additive and
  non-breaking; enables the generated API reference.
- **`transformNote`** — a new `NotesApi` method: run a caller-supplied
  whole-note transform inside the per-file lock with write-through indexing,
  returning `'edited' | 'unchanged'` (`TransformOutcome`). `allowCreate` is
  false (a missing file + non-null transform throws `REFUSE_CREATE`). The
  callback is re-invoked on mtime-conflict retries and must be pure. Enables an
  atomic "conditionally edit frontmatter + body in one commit" for consumers.

## 0.1.0 — 2026-06-28

First public release — a headless markdown-vault data layer for Bun. The `.md`
files on disk are the source of truth; a derived `bun:sqlite` index provides
collection queries, backlinks, and search.

- **`createVault`** — the composition root and primary entry point, wiring the
  IO chokepoint, index, query, and notes layers into a single `Vault`.
- **Notes CRUD** — `createNote`, `readNote`, `updateNote`, `editFrontmatter`,
  and `deleteNote` over `.md` files with flat YAML frontmatter. Edits preserve
  formatting and are write-through indexed inside the same per-file lock as the
  file write, so the file and its index row never drift.
- **Derived SQLite index** — a rebuildable cache, never the source of truth:
  `queryNotes` filters by tag, frontmatter field, or folder with ordering and
  pagination; `backlinks` / `outboundLinks` walk the link graph; `searchText`
  runs FTS5 keyword search with highlighted snippets.
- **Links** — `[[wikilink]]` and relative-link extraction with asymmetric
  resolution (`linkResolution: 'wikilink' | 'relative'`).
- **vault-io security chokepoint** — per-instance read/write path allowlists,
  NFC path canonicalization, and realpath/symlink containment. Queries return
  only notes the instance is allowed to read.
- **Concurrency & durability** — atomic writes with mtime compare-and-swap, an
  in-process mutex plus optional cross-process lockfiles, and lazy background
  reconcile that picks up out-of-band edits without blocking reads.
- **Typed errors** — every failure throws `MdVaultError` with a stable `code`
  (`ALREADY_EXISTS`, `NOT_FOUND`, `ALLOWLIST_VIOLATION`, `MTIME_CONFLICT`, …).
- **Lower-level primitives** exported for advanced use: `createVaultIo`,
  `withFileTransform`, `withFileDelete`, `parseFrontmatter`, `editFrontmatter`,
  `extractLinks`, `storedLinksFor`, and more.
- Ships as a bundled ESM `dist/` with type declarations. Bun-only at runtime
  (the bundle imports `bun:sqlite`).
