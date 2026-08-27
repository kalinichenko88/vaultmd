import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVaultIo, type VaultIo } from '@/vault-io/index.ts';

import type { IndexConfig } from '../models/index-config.ts';
import { deriveTitle, projectRow } from '../project.ts';

let dir: string;
let io: VaultIo;
const cfg: IndexConfig = {
  linkResolution: 'wikilink',
  caseSensitive: true,
  ignore: [],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vaultmd-'));
  // caseSensitive: true makes toKey === toVaultRelative -> deterministic on any volume
  io = createVaultIo({
    root: dir,
    prefixes: { read: [''], write: [''] },
    caseSensitive: true,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('deriveTitle', () => {
  test('prefers a non-empty string frontmatter.title over an H1', () => {
    expect(
      deriveTitle({ title: 'From FM' }, '# H1 heading\n\nbody', 'notes/x.md'),
    ).toBe('From FM');
  });

  test('falls back to the first H1 line (ignoring H2) when no frontmatter title', () => {
    const body = 'intro line\n## not-h1\n# Real Heading\nmore';
    expect(deriveTitle({}, body, 'notes/x.md')).toBe('Real Heading');
  });

  test('ignores a non-string title and a non-H1 hash, then uses basename', () => {
    expect(
      deriveTitle({ title: 42 }, '## subhead only', 'notes/My File.md'),
    ).toBe('My File');
  });

  test('falls back to basename without .md when nothing else matches', () => {
    expect(deriveTitle({}, 'no heading here', 'folder/Deep Note.md')).toBe(
      'Deep Note',
    );
  });

  test('ignores an H1 inside a fenced code block', () => {
    const body = '```\n# not a title, a shell comment\n```\n# real\n';
    expect(deriveTitle({}, body, 'n.md')).toBe('real');
  });

  test('a whitespace-only H1 falls back to the filename', () => {
    expect(deriveTitle({}, '#   \n', 'n.md')).toBe('n');
  });

  test('strips a closing hash sequence', () => {
    expect(deriveTitle({}, '# Title ##\n', 'n.md')).toBe('Title');
  });

  test('accepts up to three spaces of indent', () => {
    expect(deriveTitle({}, '  # Indented\n', 'n.md')).toBe('Indented');
    expect(deriveTitle({}, '    # Four\n', 'n.md')).toBe('n');
  });

  test('unchanged shapes stay unchanged', () => {
    expect(deriveTitle({}, '# Title\n', 'n.md')).toBe('Title');
    expect(deriveTitle({}, '#\tTabbed\n', 'n.md')).toBe('Tabbed');
    expect(deriveTitle({}, '#\n', 'n.md')).toBe('n');
    expect(deriveTitle({}, '## Only H2\n', 'n.md')).toBe('n');
    expect(deriveTitle({ title: 'From FM' }, '# Body\n', 'n.md')).toBe(
      'From FM',
    );
  });
});

describe('projectRow', () => {
  test('builds path/pathKey/title/frontmatterJson/tags/links from a real vaultIo', () => {
    const content = [
      '---',
      'title: Projected',
      'tags: [alpha, beta]',
      '---',
      '# Ignored Heading',
      '',
      'Body referencing [[Folder/Target]] and ![[pic.png]].',
    ].join('\n');

    const row = projectRow(content, 'Folder/Note.md', io, cfg);

    expect(row.path).toBe('Folder/Note.md');
    expect(row.pathKey).toBe('Folder/Note.md'); // caseSensitive: true -> key === display path
    expect(row.title).toBe('Projected'); // frontmatter.title wins over the H1
    expect(row.tags).toEqual(['alpha', 'beta']);
    expect(JSON.parse(row.frontmatterJson)).toEqual({
      title: 'Projected',
      tags: ['alpha', 'beta'],
    });

    const wl = row.links.find((l) => l.target === 'Folder/Target');
    expect(wl).toBeDefined();
    expect(wl?.kind).toBe('wikilink');
    expect(wl?.base).toBe('target'); // path-qualified target preserved; base case-folded
  });

  test('title falls back to the H1 when frontmatter has no title', () => {
    const content = '---\ntags: [x]\n---\n# Real H1\n\ntext';
    const row = projectRow(content, 'a.md', io, cfg);
    expect(row.title).toBe('Real H1');
  });
});

describe('projectRow — nested and invalid frontmatter', () => {
  test('a nested map is projected as nested JSON', () => {
    const row = projectRow(
      '---\nmeta:\n  status: open\n---\nbody\n',
      'n.md',
      io,
      cfg,
    );

    expect(JSON.parse(row.frontmatterJson)).toEqual({
      meta: { status: 'open' },
    });
  });

  // A YAML anchor cycle used to reach JSON.stringify and throw a raw
  // TypeError, aborting the whole reconcile sweep from reconcile.ts:74.
  test('a cyclic block projects to an empty map without throwing', () => {
    const row = projectRow('---\na: &x\n  b: *x\n---\nbody\n', 'n.md', io, cfg);

    expect(row.frontmatterJson).toBe('{}');
    expect(row.tags).toEqual([]);
  });

  test('an invalid block drops the tags and title that shared it', () => {
    const row = projectRow(
      '---\na: .nan\ntags: [x]\ntitle: kept\n---\nbody\n',
      'n.md',
      io,
      cfg,
    );

    expect(row.frontmatterJson).toBe('{}');
    expect(row.tags).toEqual([]);
    expect(row.title).toBe('n');
  });
});
