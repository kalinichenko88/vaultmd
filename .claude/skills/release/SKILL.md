---
name: release
description: >-
  Cut and publish a new npm release of vaultmd. Use this WHENEVER the
  user wants to release, publish, ship a new version, bump the version, cut a
  tag, or generate a changelog entry for this package — even if they only say
  "release it" or "let's publish". Drives the whole local side of the release:
  derive the next semver version from the commit history, write the CHANGELOG
  section, sync `package.json`, check and refresh `README.md` for accuracy,
  run the full verification suite, commit, push, and (only after explicit
  confirmation) tag — the tag push triggers the GitHub Actions npm-publish
  workflow. Then open a draft GitHub Release with friendly notes and publish it
  once CI confirms the npm publish succeeded.
---

# Releasing vaultmd

## How releasing works here

Publishing is **tag-driven and runs in CI**, not locally. The
`.github/workflows/release.yml` workflow fires on any `v*` tag push and runs
`bun install --frozen-lockfile → bun run check → bun test → bun run smoke → npm publish --access public`.
It authenticates through npm **trusted publishing** (OIDC): no token, no repo
secret. The trusted publisher on npmjs.com is `kalinichenko88/vaultmd`, workflow
`release.yml`, no environment, with `npm publish` allowed. Trusted publishing
also makes the provenance statement, so the workflow passes no `--provenance`.

The workflow publishes **exactly the `version` in `package.json`** — it does not
derive the version from the tag. So the one invariant this skill exists to protect
is: **`package.json` version === the tag name without the leading `v`.** If they
ever drift, you publish the wrong version.

The workflow also self-enforces two guards before publishing — the tag must equal
`v` + the `package.json` version, and the tagged commit must be on `origin/main`.

Your job is everything around that CI publish: pick the version, write the
changelog, sync `package.json`, prove the build is green, commit, push, and — after
an explicit confirmation, because pushing the tag publishes to npm and **an npm
version number can never be used again, even after an unpublish** — push the tag.
You also own the GitHub Release: create it as a **draft** right after tagging, then
**publish the draft only once CI confirms the npm publish succeeded**. That ordering
means a failed publish never leaves a public GitHub Release pointing at a version
nobody can install.

## Preconditions — check before doing anything

Run these and stop with a clear message if any fails. Releasing from a dirty or
stale tree produces a release that doesn't match what's reviewed.

```sh
git rev-parse --abbrev-ref HEAD     # must be main
git status --porcelain              # must be empty (clean tree)
git fetch --tags origin             # so the "last tag" below is accurate
git pull --ff-only origin main      # bring in the PRs merged on GitHub
```

- **Not on `main`** → ask the user to switch or confirm they really want to release
  from this branch.
- **Dirty tree** → stop. Uncommitted work must be committed or stashed first; the
  release commit should contain only the version bump + changelog.
- **Pull refused** (`Not possible to fast-forward`) → stop. Local `main` has
  commits that `origin/main` does not have. Show them with
  `git log --oneline origin/main..main` and let the user decide. Do not merge or
  rebase them yourself.
- It's fine if `dist/` shows as modified after a build later — that's gitignored.

## Step 1 — Gather state

```sh
bun -e "console.log(require('./package.json').version)"   # current version
git describe --tags --abbrev=0 2>/dev/null                # last release tag (may be absent)
npm view vaultmd version --prefer-online                  # last version on npm (404 before the first release)
```

Call the last tag `<tag>`. Before anything else, check that the previous release
is finished. A session can end while its CI runs, and leave it half done.

**A tag that reached npm with its release still a draft.** When `npm view` prints
the version of `<tag>`, check its GitHub Release:
`gh release view <tag> --json isDraft -q .isDraft`. If it prints `true`, finish
that release at Step 8, **On success**, with `<version>` as the version of `<tag>`.

**A tag that never reached npm.** When `npm view` prints a version and `<tag>` is
not `v` + that version, the publish of `<tag>` has not reached npm. Find its run
with `gh run list --workflow=release.yml --limit=5`, and choose by its state:

- **Still running, or succeeded:** the publish is not done yet, or the registry
  lags. Do not start a new release: finish that one at Step 8, with `<version>` as
  the version of `<tag>`.
- **Failed or cancelled:** read why with `gh run view <run-id> --log-failed`. A
  rerun runs the files of the tagged commit again, so judge the cause from those
  files (`git show <tag>:.github/workflows/release.yml`,
  `git show <tag>:package.json`), not from `HEAD`.
  - A cause outside the repository, a cancelled run, or a transient error (the
    network, a registry outage): a rerun of that run fixes it, not a new version.
    Go to Step 8, **On failure**, with `<version>` as the version of `<tag>`.
  - A cause in those files: when `HEAD` still has it, pause the release. Tell the
    user, commit the fix on `main`, push it, and start again at the preconditions.
    When `HEAD` has the fix, this run is a **re-cut**. Delete the draft of the
    failed version if it is still there (`gh release delete <tag> --yes`). Then
    `<last-tag>` below is `v<npm version>`, not `<tag>`, so the range also holds
    the commits of the failed version, which ship in this one.

When a release finished at Step 8 this way, start again at the preconditions for
the commits after its tag.

Then collect the commits since the last tag. If there is **no** prior tag, use the
whole history (`git log --oneline`) — this is the first release.

```sh
git log <last-tag>..HEAD --pretty=format:'%s%n%b' --no-merges
```

If there are **zero** commits since the last tag, stop — there's nothing to release.

## Step 2 — Propose the version (and let the user confirm)

**First release (no prior release yet).** If `npm view vaultmd version` returns a
404 **or** there is no prior `v*` tag, this is the first publish: publish the
current `package.json` version **as-is** (`v0.1.0`) and skip the bump rules
entirely — do not propose `0.2.0`. Only apply the bump rules below once a prior
release exists, or if the user explicitly asks for a different first version.

Classify the commits by their conventional-commit prefix and propose a bump. Always
**show your reasoning** ("3 feat, 1 fix, no breaking → minor → 0.2.0") and let the
user override — you're proposing, not deciding.

Bump rules depend on whether the package is pre-1.0, because semver treats `0.x`
specially (anything may change in `0.x`, so breaking changes don't force a major):

**Pre-1.0 (current `0.x.y`):**
- breaking change (`feat!`, `fix!`, or a `BREAKING CHANGE:` footer) → **minor** (`0.1.0 → 0.2.0`)
- `feat:` → **minor** (`0.1.0 → 0.2.0`)
- only `fix` / `perf` / `refactor` / `docs` / `chore` → **patch** (`0.1.0 → 0.1.1`)

**Post-1.0 (`>=1.0.0`):**
- breaking → **major**
- `feat:` → **minor**
- everything else → **patch**

**Re-cut.** Apply the rules to the npm version, not to the `package.json` version,
which is the failed one. If the result is not above the failed version, propose the
next patch of the failed version: npm has `0.11.1`, `v0.12.0` failed, the range
holds `feat` → minor → `0.12.0`, not above → `0.12.1`.

State the proposed new version explicitly and get a yes (or an override) before
editing files. This is the only judgement call in the flow — don't skip the confirm.

## Step 3 — Generate the CHANGELOG section

**If `CHANGELOG.md` does not exist yet (first release),** create it with a
`# Changelog` title followed by the first version section. On every later release,
prepend the new section directly under the `# Changelog` title as usual.

Generate the section automatically from the commits; you don't need to ask the user
to hand-write it. Match the **existing style** in `CHANGELOG.md` exactly — read the
top of the file first to mirror it. The established shape is:

```markdown
## <version> — <YYYY-MM-DD>

- <grouped, human-readable bullets>
```

Conventions to follow:
- Heading format is `## X.Y.Z — YYYY-MM-DD` with an em dash. Get today's date from
  `date +%Y-%m-%d` (don't guess it).
- Group related commits into readable bullets rather than dumping raw commit
  subjects. Drop noise (`chore: release …`, formatting-only, CI tweaks) unless it's
  user-visible. The reader is a library consumer deciding whether to upgrade —
  write for them, not for git.
- Prefer the project's domain vocabulary (the layer names "vault-io", "note-index",
  "query", "notes", "frontmatter", "links", "locks", "fs-atomic") over commit hashes.
- Insert the new section directly under the `# Changelog` title, above the previous
  version's section.
- In a re-cut, `CHANGELOG.md` already has a section for the failed version, which
  is not on npm. Merge its bullets into the new section and remove its heading.

## Step 4 — Apply the edits

1. Bump `version` in `package.json` to the agreed value.
2. Prepend the new section to `CHANGELOG.md`.

Re-read `package.json` after editing and confirm `version` is exactly the agreed
string — this is the value CI will publish.

### README currency check (run before the verify gate; commit with the release)

Check and fix `README.md` against the actual codebase and the release being cut:

1. **Publish/status accuracy.** On the **first** real release, flip the Status
   section + the `status-pre--release` badge to "published", and remove the
   "Not yet on npm" callout under Install so `bun add vaultmd` stands alone. On
   later releases, ensure no stale "not yet published / bundling pending" text
   survives.
2. **Version references** in prose (e.g. "Pre-release (`0.1.0`)") match the new
   `package.json` version.
3. **Public-API accuracy.** Exports named in the API section + the "Lower-level
   primitives" import block match the frozen public surface in `src/index.ts`
   (the name set guarded by `src/__tests__/index.test.ts`). If exports were
   added/removed/renamed this cycle, update the README to match.
4. **Examples valid.** Quick-start and API snippets use current signatures (e.g.
   `createVault` config options match the option table / config type).
5. **Requirements/Development** sections match `package.json` `engines.bun`, the
   install command, and the `bun run` scripts.

Then stage `README.md` into the release commit when anything changed.

## Step 5 — Verify (this gate must be green before anything is committed)

Run the **same checks CI runs, in the same order**:

```sh
bun run check     # biome + tsc — the authoritative gate
bun test
bun run smoke     # build + pack/install/import/typecheck the real tarball
```

If **any** step fails, **abort the release**: report which step failed with its
output, and do not commit, push, or tag. A red build must never become a tag,
because the tag is the publish trigger. Revert the version/changelog edits or leave
them for the user to fix — say which you did.

## Step 6 — Commit and push the branch

```sh
git add package.json CHANGELOG.md README.md
git commit -m "chore: release v<version>"
git push origin main
```

Only `package.json`, `CHANGELOG.md`, and `README.md` should be in this commit.
`dist/` is gitignored and must not be staged.

## Step 7 — Tag, then open a DRAFT GitHub Release (explicit confirmation required)

This is the irreversible step. **Before tagging, ask the user to confirm in plain
terms**, e.g.: "Ready to publish `v<version>` to npm? Pushing the tag triggers the
release workflow, and the version number can never be used again. Proceed?"

Only after an explicit yes, push the tag:

```sh
git tag v<version>
git push origin v<version>      # ← triggers release.yml → npm publish
```

Double-check the tag matches `package.json` before pushing: `v` + the version you
just committed. If they don't match, stop — fix the mismatch first.

Then immediately create the GitHub Release **as a draft**. It stays a draft until
the npm publish actually succeeds (Step 8), so a failed publish never leaves a
public release pointing at a version that isn't on npm.

```sh
gh release create v<version> --draft --title "v<version>" --notes "<release notes>"
```

`gh` uses the local user's auth (scope `repo`), so no workflow permission changes
are needed. The tag already exists on the remote, so the release attaches to it.

### Writing the release notes

These notes are **for humans skimming the Releases page**, not for the changelog
reader. Keep them warm and high-level — **minimise technical detail**:

- Open with one or two sentences on what this release gives the user / what changed.
- Then a short bullet list of the headline, user-facing changes in plain language.
- **Leave out** internals: no test names, file paths, commit hashes, CI/build/lint
  notes, or refactors that don't change behaviour. If it wouldn't matter to someone
  installing the package, drop it.
- For a first release, frame it as an introduction ("what this package does")
  rather than a diff.
- End with a pointer to the full changelog, e.g. `See CHANGELOG.md for full detail.`

Derive the substance from the same commits, but rewrite — don't paste the CHANGELOG
section. The changelog is the precise record; the release note is the friendly pitch.

## Step 8 — Watch CI, then publish the release

Watch the publish workflow (the tag push started it; the run may take a few seconds
to appear, so retry the list once if it's empty):

```sh
gh run watch --exit-status $(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')
```

**On success** — confirm the version is live, then flip the draft to published:

```sh
npm view vaultmd version --prefer-online   # should print <version>; the registry can lag a minute, so retry
gh release edit v<version> --draft=false      # publish the GitHub Release
```

If `v<version>` has no draft, because the session that pushed the tag ended
before `gh release create`, create it first with the Step 7 command and notes.

Report the published version plus the npm and GitHub Release URLs.

**On failure** — leave the GitHub Release as a draft (do not publish it) and surface
the failing log. Common causes:

- `E404 Not Found - PUT https://registry.npmjs.org/vaultmd` or `ENEEDAUTH`: npm
  could not authenticate through trusted publishing. Check the workflow of the
  tagged commit first (`git show v<version>:.github/workflows/release.yml`): it
  needs `permissions: id-token: write` and npm 11.5.1 or later. The setup-node step
  of the log names the Node version; recent Node 24 releases ship npm 11.5.1 or
  later, but 24.0 shipped 11.3. A gap there is in the repository, even when a later
  commit fixed it, because a rerun runs the tagged commit. Otherwise the trusted
  publisher on npmjs.com does not match the run (owner, repository, workflow file
  name, environment), or it does not allow `npm publish`.
- A provenance error: the `repository` field is missing from `package.json`, or
  it does not match the GitHub repository.

The tag is already pushed, so never retag the same version. First check whether
the version reached npm: `npm view vaultmd@<version> version --prefer-online`.
If it prints `<version>`, the publish went through: go on with **On success**. If
it exits 1 with `npm error 404 No match found for version <version>`, choose by
where the cause is:

- **Outside the repository** (the npm settings, a GitHub setting): only the user
  can change them. Ask the user to fix the cause and confirm. A cancelled run or a
  transient error (the network, a registry outage) needs no fix. Then rerun the
  failed run with `gh run rerun <run-id>`, where `<run-id>` is what
  `gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId'`
  prints. The rerun runs the tagged commit and publishes the same tag. Watch it with
  `gh run watch --exit-status <run-id>`, and when it succeeds, go on with
  **On success**.
- **In the repository** (the workflow or `package.json` of the tagged commit): fix
  it in a new commit. Delete the draft of the failed version with
  `gh release delete v<version> --yes`: that version is not on npm. The tag
  stays. Then release again from the preconditions: Step 1 finds the failed tag
  and runs a **re-cut**, which ships the failed version's changes in the next
  version.
