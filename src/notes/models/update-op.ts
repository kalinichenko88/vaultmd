/**
 * Describes a mutation to apply to a note's body via {@link NotesApi.updateNote}.
 * Exactly one variant must be set per call.
 */
export type UpdateOp =
  | {
      /**
       * Find-and-replace a unique substring in the note body. The old text
       * must match exactly once — zero matches throw `NOT_FOUND`, multiple
       * matches throw `AMBIGUOUS_MATCH`.
       */
      editByMatch: {
        /** Exact substring to locate in the note body. */
        old: string;
        /** Replacement text for the matched substring. */
        new: string;
      };
    }
  | {
      /** Text to append verbatim to the end of the note body. */
      append: string;
    };
