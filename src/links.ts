import { posix } from 'node:path';

export type ExtractedLinks = {
  wikilinks: string[];
  embeds: string[];
  mdLinks: string[];
};

export type LinkResolution = 'wikilink' | 'relative';

export type StoredLink = {
  target: string;
  base: string | null;
  kind: 'wikilink' | 'embed' | 'mdlink';
};

function stripFencedCode(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      out.push(line);
    }
  }

  return out.join('\n');
}

function mdLinkUrl(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('<')) {
    const end = t.indexOf('>');

    return (end >= 0 ? t.slice(1, end) : t.slice(1)).trim();
  }

  return t.split(/\s+/)[0];
}

export function extractLinks(content: string): ExtractedLinks {
  const src = stripFencedCode(content);
  const wikilinks: string[] = [];
  const embeds: string[] = [];
  const mdLinks: string[] = [];

  for (const m of src.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const raw = m[2].trim();
    if (!raw) continue;
    if (m[1] === '!') {
      embeds.push(raw);
    } else {
      wikilinks.push(raw);
    }
  }

  for (const m of src.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = mdLinkUrl(m[1]);
    if (!url) continue;
    mdLinks.push(url);
  }

  return { wikilinks, embeds, mdLinks };
}

function normalizeWikiTarget(raw: string): string {
  let t = raw;
  const pipe = t.indexOf('|');
  if (pipe >= 0) t = t.slice(0, pipe);
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  t = t.trim().replace(/\\/g, '/').normalize('NFC');
  if (t.startsWith('./')) t = t.slice(2);
  t = t.replace(/\.md$/i, '');

  return t;
}

function resolveRelativeTarget(raw: string, srcDir: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // external scheme (http(s)/mailto/...)
  if (t.startsWith('#')) return null; // bare in-note anchor
  t = t.split('#')[0];
  if (!t) return null;
  if (t.startsWith('/')) return null; // absolute path
  let resolved = posix.normalize(posix.join(srcDir, t)).normalize('NFC');
  if (resolved.startsWith('../') || resolved === '..') return null; // escapes root
  if (resolved.startsWith('./')) resolved = resolved.slice(2);
  if (!resolved) return null;
  if (!/\.md$/i.test(resolved)) return null; // only vault-internal .md

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
      if (!target) return;
      const base = (target.split('/').pop() ?? target).toLowerCase();
      out.push({ target, base, kind });
    };
    for (const w of links.wikilinks) push(w, 'wikilink');
    for (const e of links.embeds) push(e, 'embed');

    return out;
  }

  const srcDir = posix.dirname(
    srcRel.trim().replace(/\\/g, '/').normalize('NFC'),
  );
  for (const raw of links.mdLinks) {
    const target = resolveRelativeTarget(raw, srcDir);
    if (!target) continue;
    out.push({ target, base: null, kind: 'mdlink' });
  }

  return out;
}
