# 0002 An update stays atomic; the mode and the owner carry over, extended attributes and hard links do not

- Status: accepted
- Level: project
- Date: 2026-11-13

## Decision

An update writes the new text to a file next to the note, syncs it, and renames
it over the note. The new file gets the note's mode, and its owner and group
where the OS lets the writer set them. Extended attributes (macOS Finder tags,
for example) and hard links stay with the old file: after an update the note
has no extended attributes, and a hard link to it keeps the old text.

## Rests on

- A crash, a kill or `ENOSPC` during an update leaves the old note or the new
  one, never a cut-off one (#41, #43). Agents write often and can be stopped at
  any time.
- The mode keeps a note private: a `0600` note must not become `0644` after an
  update (#46).

## Revisit when

A user needs extended attributes or hard links to survive an update.

## Options considered

- Write in place, with `writeFile` on the note's path: keeps the mode, the
  owner, the extended attributes and the hard links, but a crash or `ENOSPC`
  during the write leaves a cut-off note.

## Links

#46, #41, #43
