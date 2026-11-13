# 0001 One file has one path: no symlinks inside the vault

- Status: accepted
- Level: project
- Date: 2026-11-13

## Decision

vaultmd refuses a path that has a symlink on it under the vault root, on any
segment, dangling or not. A read, a write, `stat` and `readBinary` on such a
path throw `ALLOWLIST_VIOLATION`, and `listMarkdown` / `listFolders` skip the
link and never follow it. The root itself, and the folders above it, may be
links.

## Rests on

- The users of vaultmd are AI agents that work through its API. The API cannot
  make a link, so a link in the vault comes only from a person who made it by
  hand. (the maintainer, 2026-11-13)
- vaultmd already refused links that leave the vault. The only links left were
  links to a note or a folder inside the vault: a second name for a file that
  the vault already holds.
- The support of those links cost bugs and guards: a hidden note read through a
  visible link (#39), cycles in the folder walk, an update that replaced a
  linked note with a regular file (#46). A linked note also had two index rows
  and two lock keys.

## Revisit when

A user needs a folder that is outside the vault, linked into it, to be read or
written through vaultmd.

## Options considered

- Write through a link to its real target: keeps the links, and keeps every
  guard that they need.
- Read through links, refuse writes: a note can be read through its link but
  not changed, and the read guards stay.

## Links

#46, #39, PR #40
