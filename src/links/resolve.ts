import { posix } from 'node:path';

import { extractLinks } from './extract.ts';
import type { LinkResolution } from './models/link-resolution.ts';
import type { StoredLink } from './models/stored-link.ts';

function normalizeWikiTarget(raw: string): string {
  let t = raw;
  const pipe = t.indexOf('|');
  if (pipe >= 0) {
    t = t.slice(0, pipe);
  }
  const hash = t.indexOf('#');
  if (hash >= 0) {
    t = t.slice(0, hash);
  }
  t = t.trim().replace(/\\/g, '/').normalize('NFC');
  if (t.startsWith('./')) {
    t = t.slice(2);
  }
  t = t.replace(/\.md$/i, '');

  return t;
}

function resolveRelativeTarget(raw: string, srcDir: string): string | null {
  let t = raw.trim();
  if (!t) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    return null; // external scheme (http(s)/mailto/...)
  }
  if (t.startsWith('#')) {
    return null; // bare in-note anchor
  }
  t = t.split('#')[0];
  if (!t) {
    return null;
  }
  if (t.startsWith('/')) {
    return null; // absolute path
  }
  let resolved = posix.normalize(posix.join(srcDir, t)).normalize('NFC');
  if (resolved.startsWith('../') || resolved === '..') {
    return null; // escapes root
  }
  if (resolved.startsWith('./')) {
    resolved = resolved.slice(2);
  }
  if (!resolved) {
    return null;
  }
  if (!/\.md$/i.test(resolved)) {
    return null; // only vault-internal .md
  }

  return resolved;
}

export function storedLinksFor(
  content: string,
  srcRel: string,
  mode: LinkResolution,
): StoredLink[] {
  const links = extractLinks(content);
  const out: StoredLink[] = [];

  if (mode === 'wikilink') {
    const push = (raw: string, kind: 'wikilink' | 'embed') => {
      const target = normalizeWikiTarget(raw);
      if (!target) {
        return;
      }
      const base = (target.split('/').pop() ?? target).toLowerCase();
      out.push({ target, base, kind });
    };
    for (const w of links.wikilinks) {
      push(w, 'wikilink');
    }
    for (const e of links.embeds) {
      push(e, 'embed');
    }

    return out;
  }

  const srcDir = posix.dirname(
    srcRel.trim().replace(/\\/g, '/').normalize('NFC'),
  );
  for (const raw of links.mdLinks) {
    const target = resolveRelativeTarget(raw, srcDir);
    if (!target) {
      continue;
    }
    out.push({ target, base: null, kind: 'mdlink' });
  }

  return out;
}
