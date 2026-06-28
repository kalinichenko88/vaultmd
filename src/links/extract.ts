import type { ExtractedLinks } from './models/extracted-links.ts';

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

/**
 * Extract all raw link tokens from a markdown file's content. Strips fenced
 * code blocks before scanning so links inside code are not collected.
 * Does not normalise or resolve targets.
 *
 * @param content Raw UTF-8 content of a markdown file.
 * @returns {@link ExtractedLinks} containing raw wikilinks, embeds, and
 *   standard markdown link URLs.
 */
export function extractLinks(content: string): ExtractedLinks {
  const src = stripFencedCode(content);
  const wikilinks: string[] = [];
  const embeds: string[] = [];
  const mdLinks: string[] = [];

  for (const m of src.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const raw = m[2].trim();
    if (!raw) {
      continue;
    }
    if (m[1] === '!') {
      embeds.push(raw);
    } else {
      wikilinks.push(raw);
    }
  }

  for (const m of src.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = mdLinkUrl(m[1]);
    if (!url) {
      continue;
    }
    mdLinks.push(url);
  }

  return { wikilinks, embeds, mdLinks };
}
