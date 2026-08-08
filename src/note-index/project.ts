import { basename } from 'node:path';

import { deriveTags, parseFrontmatter } from '@/frontmatter/index.ts';
import { extractHeadings } from '@/headings/index.ts';
import { type StoredLink, storedLinksFor } from '@/links/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

import type { IndexConfig } from './models/index-config.ts';

export function deriveTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  rel: string,
): string {
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim() !== '') {
    return fmTitle;
  }

  // One ATX grammar for the whole package: fence-aware, 0-3 spaces of indent,
  // closing hashes stripped. An empty heading is not a title.
  const h1 = extractHeadings(body).find((h) => h.level === 1 && h.text !== '');
  if (h1) {
    return h1.text;
  }

  return basename(rel).replace(/\.md$/i, '');
}

export function projectRow(
  content: string,
  rel: string,
  vaultIo: Pick<VaultIo, 'toVaultRelative' | 'toKey'>,
  cfg: IndexConfig,
): {
  path: string;
  pathKey: string;
  title: string;
  frontmatterJson: string;
  tags: string[];
  links: StoredLink[];
} {
  const path = vaultIo.toVaultRelative(rel);
  const pathKey = vaultIo.toKey(rel);
  const parsed = parseFrontmatter(content);
  const tags = deriveTags(parsed.frontmatter);
  const title = deriveTitle(parsed.frontmatter, parsed.body, path);
  const links = storedLinksFor(content, path, cfg.linkResolution);
  const frontmatterJson = JSON.stringify(parsed.frontmatter);

  return { path, pathKey, title, frontmatterJson, tags, links };
}
