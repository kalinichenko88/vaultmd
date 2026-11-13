# 0003 A writer's lock is stale by its age alone

- Status: accepted
- Level: project
- Date: 2026-11-13

## Decision

A cross-process writer lock is taken over only when nobody has refreshed it
for 30 seconds and the waiting write has seen it stay so for 3 more. vaultmd
does not check the pid or the host name in the lockfile to take a lock over
sooner. After a writer dies inside its lock, writes to that note fail with
`MTIME_CONFLICT` for about 33 seconds.

## Rests on

- A host name does not name a PID namespace. The containers of one Kubernetes
  pod share the host name and, by default, not the PID namespace; so do Docker
  containers with `--uts=host` or a fixed `hostname:`. A waiter there that
  checks a live holder's pid gets `ESRCH`, takes the lock, and two writers are
  inside the lock of one note. (#62)
- A holder refreshes its lockfile every second, so the age alone finds a dead
  holder. The pid check only made the takeover sooner. (#50, PR #63)
- A writer holds the lock only for one file write and its index commit, so a
  writer that dies inside the lock is rare. `MTIME_CONFLICT` is an error that
  the caller can retry.
- Obsidian takes no lock on a note. Chromium's process lock, the nearest case
  in its stack, checks that the holder answers on a socket before it reads the
  pid. Here the heartbeat is that check.

## Revisit when

A user reports that the 33-second block after a crash costs them work, or the
lock gets a liveness check that does not depend on the pid.

## Options considered

- Keep the pid check, and record the PID namespace (`boot_id` and the inode of
  `/proc/self/ns/pid` on Linux) beside the pid; check the pid only when both
  match. Keeps the instant takeover; adds Linux-only code that only CI runs.
- Keep the pid check as it was: two writers in one lock, with no CAS for a
  create (#45).

## Links

#62, #50, PR #63, #45
