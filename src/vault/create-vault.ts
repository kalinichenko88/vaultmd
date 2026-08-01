import { dirname } from 'node:path';

import { MdVaultError } from '@/errors.ts';
import {
  applySchema,
  configFingerprint,
  createReconciler,
  type IndexConfig,
  openIndexDb,
  probeCapabilities,
  type ReconcileResult,
  readMeta,
  SCHEMA_VERSION,
} from '@/note-index/index.ts';
import { createNotes } from '@/notes/index.ts';
import { createQuery } from '@/query/index.ts';
import { createVaultIo } from '@/vault-io/index.ts';

import type { CreateVaultConfig } from './models/create-vault-config.ts';
import type { Vault } from './models/vault.ts';

/**
 * Open (or create) a vault over a folder of markdown notes. Wires the IO
 * chokepoint, the derived SQLite index, and the query/notes layers into one
 * {@link Vault}. The `.md` files on disk remain the single source of truth;
 * the index is a rebuildable cache.
 *
 * @param config Vault configuration — at minimum `root`, `indexPath`, and `prefixes`.
 * @returns A ready-to-use {@link Vault} handle. Call {@link Vault.close} when done.
 *
 * @example
 * ```ts
 * const vault = await createVault({
 *   root: './notes',
 *   // Keep the index db outside the synced vault.
 *   indexPath: './data/vault-index.db',
 *   prefixes: { read: [''], write: [''] },
 * });
 * const hits = vault.query.queryNotes({ tag: 'project' });
 * vault.close();
 * ```
 */
export async function createVault(config: CreateVaultConfig): Promise<Vault> {
  const linkResolution = config.linkResolution ?? 'wikilink';
  const lazyReconcile = config.lazyReconcile ?? true;
  const reconcileTtlMs = config.reconcileTtlMs ?? 2000;
  const sqliteBusyTimeoutMs = config.sqliteBusyTimeoutMs ?? 5000;
  const crossProcessWriterLock = config.crossProcessWriterLock ?? true;

  const io = createVaultIo({
    root: config.root,
    prefixes: config.prefixes,
    caseSensitive: config.caseSensitive,
    ignore: config.ignore,
  });

  // Resolve the effective case-sensitivity purely from the public VaultIo
  // surface: on a case-insensitive volume toKey case-folds, so it differs
  // from the case-preserving toVaultRelative; on a case-sensitive volume
  // the two agree.
  const caseSensitive = io.toKey('A.md') === io.toVaultRelative('A.md');

  const cfg: IndexConfig = {
    linkResolution,
    caseSensitive,
    ignore: config.ignore ?? [],
  };

  const db = openIndexDb(config.indexPath, { sqliteBusyTimeoutMs });
  probeCapabilities(db);
  applySchema(db);

  const reconciler = createReconciler(db, io, cfg);

  // This instance owns the whole index iff its read scope covers the entire
  // vault (the empty-string prefix). Only an owner may rebuild a shared index
  // out from under another scope.
  const ownsWholeIndex = config.prefixes.read.includes('');

  const cur = configFingerprint(cfg);
  const stored = readMeta(db, 'config_fingerprint');
  const storedVer = readMeta(db, 'schema_version');

  if (stored === null) {
    // Fresh / never-built index -> boot build (rebuild writes both meta keys).
    await reconciler.rebuild();
  } else if (stored !== cur || storedVer !== String(SCHEMA_VERSION)) {
    if (ownsWholeIndex) {
      await reconciler.rebuild();
    } else {
      db.close();
      throw new MdVaultError(
        'INDEX_UNAVAILABLE',
        'index config fingerprint mismatch on a shared index not owned by this scope',
      );
    }
  } else {
    const row = db.query('PRAGMA integrity_check').get() as {
      integrity_check?: string;
    } | null;
    if (row?.integrity_check !== 'ok') {
      await reconciler.rebuild();
    }
  }

  // Lazy reconcile: the first read (and the first read after each TTL window)
  // kicks ONE background sweep, guarded so concurrent reads never overlap it.
  // Reads stay synchronous (their return types must equal createQuery's), so
  // the sweep is fire-and-forget — its result is visible to the NEXT read.
  let lastReconcileMs = 0;
  let inFlight: Promise<unknown> | null = null;

  // Every sweep folds its result in here and reconcile() drains it. A
  // background sweep applies changes nobody asked for, so without this buffer
  // any change a query-triggered sweep happened to reach first would be
  // indexed and then never reported — the feed would silently lose it.
  const pending = new Map<string, keyof ReconcileResult>();

  function absorb(changed: ReconcileResult): void {
    for (const path of changed.added) {
      // Re-added over a removal nobody has drained yet reads as an update:
      // the consumer still believes the file is there.
      pending.set(path, pending.get(path) === 'removed' ? 'updated' : 'added');
    }
    for (const path of changed.updated) {
      // A pending 'added' outranks it — the consumer has not seen the file yet.
      pending.set(path, pending.get(path) === 'added' ? 'added' : 'updated');
    }
    for (const path of changed.removed) {
      if (pending.get(path) === 'added') {
        pending.delete(path); // created and deleted between drains: a non-event
        continue;
      }
      pending.set(path, 'removed');
    }
  }

  function drain(): ReconcileResult {
    const out: ReconcileResult = { added: [], updated: [], removed: [] };
    for (const [path, kind] of pending) {
      out[kind].push(path);
    }
    pending.clear();
    out.added.sort();
    out.updated.sort();
    out.removed.sort();

    return out;
  }

  // One sweep at a time, whoever asks. Two overlapping sweeps each snapshot the
  // index before the other's writes land, so a single change gets double-counted
  // or split across two reports.
  function sweep(): Promise<unknown> {
    if (!inFlight) {
      inFlight = reconciler
        .reconcile()
        .then(absorb)
        .finally(() => {
          inFlight = null;
        });
    }

    return inFlight;
  }

  function maybeReconcile(): void {
    if (!lazyReconcile || inFlight) {
      return;
    }
    const now = Date.now();
    if (now - lastReconcileMs < reconcileTtlMs) {
      return;
    }
    lastReconcileMs = now;
    sweep().catch(() => {
      // A failed lazy sweep must never break a read; the next sweep retries.
    });
  }

  const rawQuery = createQuery(db, io, cfg);
  // Every read fires one lazy reconcile, then delegates. Wrap once so the
  // sequence lives in a single place instead of being copy-pasted per method.
  function reconciled<A extends unknown[], R>(
    fn: (...args: A) => R,
  ): (...args: A) => R {
    return (...args) => {
      maybeReconcile();

      return fn(...args);
    };
  }
  // Explicit, not a loop: tsc fails this literal when QueryApi grows a method.
  const query: ReturnType<typeof createQuery> = {
    queryNotes: reconciled(rawQuery.queryNotes),
    countNotes: reconciled(rawQuery.countNotes),
    orphanNotes: reconciled(rawQuery.orphanNotes),
    backlinks: reconciled(rawQuery.backlinks),
    outboundLinks: reconciled(rawQuery.outboundLinks),
    danglingLinks: reconciled(rawQuery.danglingLinks),
    unlinkedMentions: reconciled(rawQuery.unlinkedMentions),
    outboundMentions: reconciled(rawQuery.outboundMentions),
    searchText: reconciled(rawQuery.searchText),
    countSearch: reconciled(rawQuery.countSearch),
    tags: reconciled(rawQuery.tags),
  };

  const notes = createNotes({
    db,
    vaultIo: io,
    cfg,
    query,
    onCommit: config.onCommit,
    cross: crossProcessWriterLock
      ? {
          lockDir: `${dirname(config.indexPath)}/.vaultmd-locks`,
          busyTimeoutMs: sqliteBusyTimeoutMs,
        }
      : false,
  });

  return {
    io,
    notes,
    query,
    reconcile: async () => {
      if (inFlight) {
        // Let a background sweep land instead of racing it; its result is
        // buffered, so joining it costs nothing and loses nothing.
        await inFlight.catch(() => {});
      }
      await sweep();
      lastReconcileMs = Date.now();

      return drain();
    },
    reconcilePaths: (rels) => reconciler.reconcilePaths(rels),
    rebuild: () => reconciler.rebuild(),
    close: () => {
      db.close();
    },
  };
}
