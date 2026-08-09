type FenceTracker = {
  inFence(line: string): boolean;
  isOpen(): boolean;
};

const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/**
 * Create a stateful scanner for CommonMark fenced code blocks
 * ({@link https://spec.commonmark.org/0.31.2/#fenced-code-blocks | §4.5}), fed
 * one line at a time in document order.
 *
 * Any amount of leading whitespace (spaces or tabs) can precede a fence marker.
 * This deviates from CommonMark's 0–3 space rule because this scanner has no
 * indented-code-block rule; erring toward "still a fence" hides content rather
 * than leaking it into a write path.
 *
 * A closer must use the SAME marker character as its opener and be at least as
 * long; anything else is ordinary content. That is what separates this from a
 * naive toggle, which lets a `~~~` line end a ``` block and leak whatever
 * follows.
 *
 * @returns A tracker whose `inFence` reports whether a line is a fence
 * delimiter or lies inside a fence, and whose `isOpen` reports whether a fence
 * is still unterminated after every line fed so far.
 */
/**
 * Whether `content` leaves a code fence unterminated.
 *
 * Per CommonMark an unclosed fence runs to the end of the document, so every
 * heading after it is fence content rather than a heading. Callers that address
 * or rewrite content by heading use this to refuse a region whose boundary is
 * therefore undefined.
 *
 * @param content Markdown text, scanned from its first line.
 * @returns `true` when a fence is still open after the last line.
 */
export function hasUnclosedFence(content: string): boolean {
  const tracker = createFenceTracker();
  for (const line of content.split('\n')) {
    tracker.inFence(line);
  }

  return tracker.isOpen();
}

export function createFenceTracker(): FenceTracker {
  let open: { marker: string; length: number } | null = null;

  return {
    inFence(line: string): boolean {
      const match = FENCE.exec(line.replace(/\r$/, ''));
      if (open === null) {
        if (!match) {
          return false;
        }
        const marker = match[1][0];
        // A backtick opener's info string may not contain a backtick, so
        // `" ```js `x` "` is a paragraph, not the start of a code block.
        if (marker === '`' && match[2].includes('`')) {
          return false;
        }
        open = { marker, length: match[1].length };

        return true;
      }
      if (
        match &&
        match[1][0] === open.marker &&
        match[1].length >= open.length &&
        match[2].trim() === ''
      ) {
        open = null;
      }

      return true;
    },
    isOpen(): boolean {
      return open !== null;
    },
  };
}
