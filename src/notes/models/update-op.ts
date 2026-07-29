/**
 * Describes a mutation to apply to a note's body via {@link NotesApi.updateNote}.
 * Exactly one variant must be set per call.
 */
export type UpdateOp =
  | {
      /**
       * Find-and-replace a unique substring in the note body. The frontmatter
       * block is excluded from the search and left untouched (use
       * {@link NotesApi.editFrontmatter} for that). The old text must match
       * exactly once within the body — zero matches throw `NO_MATCH`, multiple
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
      /**
       * Text to append verbatim to the end of the note body, with a newline
       * inserted first when the existing content does not end in one. Creates
       * the note when it does not exist.
       */
      append: string;
    }
  | {
      /**
       * Text to insert at the START of the note body — after the frontmatter
       * block, never before it — with a newline inserted between it and the
       * existing body when it does not already end in one. Creates the note
       * when it does not exist.
       */
      prepend: string;
    }
  | {
      /**
       * Replacement for the whole note body; the frontmatter block is preserved
       * verbatim. Does NOT create a missing note (throws `REFUSE_CREATE`) — use
       * {@link NotesApi.createNote} for that.
       */
      setBody: string;
    };
