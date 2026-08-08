type FenceTracker = {
  inFence(line: string): boolean;
  isOpen(): boolean;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Create a stateful scanner for CommonMark fenced code blocks
 * ({@link https://spec.commonmark.org/0.31.2/#fenced-code-blocks | §4.5}), fed
 * one line at a time in document order.
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
