import { createFenceTracker } from './fences.ts';
import type { Heading } from './models/heading.ts';

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;

type Line = { start: number; text: string };
type Found = { index: number; level: number; text: string; start: number };

/**
 * Extract every ATX heading (`#` through `######`) from a markdown string,
 * in document order, with the span of the section each one opens.
 *
 * Headings inside fenced code blocks are skipped, using the same CommonMark
 * rule the rest of the package applies. Setext headings (`Title` over `===`)
 * are not recognised.
 *
 * The string is scanned VERBATIM: a leading YAML frontmatter block is not
 * removed, so a `# comment` line inside one reads as a level-1 heading. Pass
 * `parseFrontmatter(content).body` when that matters — the same caveat
 * `extractLinks` carries.
 *
 * @param content Raw UTF-8 content of a markdown file, or any substring of one.
 * @returns The headings found, each carrying its {@link Heading} span offsets
 * into `content`.
 *
 * @example
 * ```ts
 * const { body } = parseFrontmatter(content);
 * const notes = extractHeadings(body).find((h) => h.text === 'Notes');
 * const section = notes ? body.slice(notes.bodyStart, notes.end) : '';
 * ```
 */
export function extractHeadings(content: string): Heading[] {
  const lines = splitLines(content);
  const tracker = createFenceTracker();
  const found: Found[] = [];

  lines.forEach((line, index) => {
    if (tracker.inFence(line.text)) {
      return;
    }
    const match = ATX.exec(line.text.replace(/\r$/, ''));
    if (!match) {
      return;
    }
    found.push({
      index,
      level: match[1].length,
      text: (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim(),
      start: line.start,
    });
  });

  return found.map((heading, i) => {
    // The section ends at the next heading that is same-or-shallower; anything
    // deeper is a subsection and stays inside. A plain indexed loop avoids
    // allocating a fresh sliced array per heading — deriveTitle runs this on
    // every note of every index rebuild.
    let closer: Found | undefined;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j].level <= heading.level) {
        closer = found[j];
        break;
      }
    }
    const stop = closer ? closer.index : lines.length;
    const filled = lines
      .slice(heading.index + 1, stop)
      .filter((line) => line.text.trim() !== '');
    const { text, level, start } = heading;
    const last = filled[filled.length - 1];
    if (last === undefined) {
      // Empty section: collapse to the line after the heading so an insert
      // lands directly under it and any separator blank line survives.
      const at = lines[heading.index + 1]?.start ?? content.length;

      return { text, level, start, bodyStart: at, end: at };
    }

    return {
      text,
      level,
      start,
      bodyStart: filled[0].start,
      // One past the last non-blank line, including its newline — Math.min
      // caps that at EOF, where the line has none.
      end: Math.min(last.start + last.text.length + 1, content.length),
    };
  });
}

function splitLines(content: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const text of content.split('\n')) {
    out.push({ start, text });
    start += text.length + 1;
  }

  return out;
}
