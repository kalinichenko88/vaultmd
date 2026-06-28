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
  dir = await mkdtemp(join(tmpdir(), 'mdvault-'));
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
