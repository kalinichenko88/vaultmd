/**
 * One ATX heading and the span of the section it opens, as returned by
 * {@link extractHeadings}. All offsets index the string that was scanned.
 */
export type Heading = {
  /** Heading text, trimmed, with any closing `##` sequence stripped. */
  text: string;
  /** ATX depth, 1 to 6. */
  level: number;
  /** Offset of the heading line's first `#`. */
  start: number;
  /**
   * Offset of the section body's first character — the start of the first
   * NON-blank line after the heading line. Equals `end` for an empty section.
   */
  bodyStart: number;
  /**
   * Offset one past the section body — one past the last non-blank line,
   * including its newline when it has one. Blank lines before the next heading
   * fall outside, so replacing `[bodyStart, end)` preserves the file's spacing.
   */
  end: number;
};
