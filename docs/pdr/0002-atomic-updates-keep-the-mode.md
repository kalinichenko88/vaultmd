# 0002 An update stays atomic; the mode and the owner carry over, extended attributes and hard links do not

- Status: accepted
- Level: project
- Date: 2026-11-13

## Updates

- 2026-11-13 #66: Decision. Was: "When the group cannot be kept, its permission bits are dropped, so they do not pass to the new file's group."
- 2026-11-13 #66: Decision. Was: no sentence on a mode that the OS refuses.
- 2026-11-13 #66: Decision. Was: no sentence on an owner that cannot be kept.
- 2026-11-13 #66: Decision. Was: "Extended attributes (macOS Finder tags, for example)".
- 2026-11-13 #66: Decision. Was: "after an update the note has no extended attributes".

## Decision

An update writes the new text to a file next to the note, syncs it, and renames
it over the note. The new file gets the note's mode (set-id bits dropped), and
its owner and group where the OS lets the writer set them, before the new text
is written into it. When the group cannot be kept, the new file's group and
its others both get only the permission bits that the note's group and its
others both have: no user reads more than before, and the members of the new
group read no less than every other user. The new file is created no wider
than the note for any user but the writer. When the OS gives it mode bits
wider than asked (the note's mode in the note's group, the shared bits in
another group), the update fails (`UNSAFE_MODE`) before any text is in it: a
chmod after the open would not close a file that another user opened in time.
A chmod that the OS refuses or ignores leaves the new file as it was created;
one that it turns into a wider mode fails the same way.
When the owner cannot be kept, the writer becomes
the owner, and the old owner keeps only what the group or the others class
gives them: no mode can give it back without widening the others. A move
gives the new note the mode and owner of the old one the same way. A chmod or chown of the note
while an update writes is a conflict (`MTIME_CONFLICT`): `updateNote` and the
other note mutations read the note again and retry, and a direct
`rewriteIfUnchanged` caller must do so itself. Three cases still undo such a
chmod or chown: one made after the final check and before the rename, one
during a blind `writeVaultFile`, and one during a move. A tmp is never
reopened by its name. Extended attributes (macOS Finder tags or a POSIX
ACL, for example) and hard links stay with the old file: after an update the
note has only the extended attributes and ACL entries that its folder gives a
new file, and a hard link to it keeps the old text.

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
