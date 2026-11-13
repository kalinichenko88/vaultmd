# 0002 An update stays atomic; the mode and the owner carry over, extended attributes and hard links do not

- Status: accepted
- Level: project
- Date: 2026-11-13

## Updates

- 2026-11-13 #66: Decision. Was: "When the group cannot be kept, its permission bits are dropped, so they do not pass to the new file's group."
- 2026-11-13 #66: Decision. Was: no sentence on a mode that the OS refuses.

## Decision

An update writes the new text to a file next to the note, syncs it, and renames
it over the note. The new file gets the note's mode (set-id bits dropped), and
its owner and group where the OS lets the writer set them, before the new text
is written into it. When the group cannot be kept, the group gets the others'
permission bits: the note's group bits do not pass to the new file's group, and
the members of that group keep what every other user has. When the OS refuses
the mode, as a mount with no mode per file does, the update goes on only while
the new file is no wider than the note's mode. A move gives the new note
the mode and owner of the old one the same way. A chmod or chown of the note
while an update writes is a conflict (`MTIME_CONFLICT`): `updateNote` and the
other note mutations read the note again and retry, and a direct
`rewriteIfUnchanged` caller must do so itself. Three cases still undo such a
chmod or chown: one made after the final check and before the rename, one
during a blind `writeVaultFile`, and one during a move. A tmp is never
reopened by its name. Extended attributes (macOS Finder tags, for
example) and hard links stay with the old file: after an update the note has
no extended attributes, and a hard link to it keeps the old text.

## Rests on

- A crash, a kill or `ENOSPC` during an update leaves the old note or the new
  one, never a cut-off one (#41, #43). Agents write often and can be stopped at
  any time.
- The mode keeps a note private: a `0600` note must not become `0644` after an
  update or a move, and its new text must not sit in a wider file while it is
  written (#46).

## Revisit when

A user needs extended attributes or hard links to survive an update.

## Options considered

- Write in place, with `writeFile` on the note's path: keeps the mode, the
  owner, the extended attributes and the hard links, but a crash or `ENOSPC`
  during the write leaves a cut-off note.

## Links

#46, #41, #43
