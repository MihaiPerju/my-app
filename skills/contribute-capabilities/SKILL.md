---
name: contribute-capabilities
description: Contribute to the `mistralai-capabilities` registry — fix a capability bug from inside an app, extract an app feature into a capability, and upstream it as a PR. Use when a change belongs to capability source rather than app source.
---

# Contributing to `mistralai-capabilities`

A capability change ships to every app built on the registry. [`REGISTRY.md`](REGISTRY.md) is the
reference for the registry repo's gates, tests and changelogs.

## Belongs upstream?

Ask: *would the next app scaffolded from this registry want it?* Yes — a bug, a missing guard —
goes upstream. No stays in the app's own files, so one customer's specifics never reach everyone
else. For a large change, upstream the general part and keep the specific part in the app.

## Work in the app

Scaffolded from a git registry, the app vendors it as a committed git subtree at
`.mistral/repositories/mistralai-capabilities/` (call it `$P`), and resolves capability packages
from it. The two zones behave differently:

- **`package/` is live**: edit it and the running app picks it up.
- **`template/` is inert**: it was copied into `apps/` at install time. Edit and test the copy under
  `apps/`, then **mirror** it to `$P/capabilities/<kind>/<id>/template/` at the same relative path —
  an unmirrored fix upstreams as nothing. Before the PR,
  `git diff --no-index apps/<path> "$P/capabilities/<kind>/<id>/template/apps/<path>"` is empty.

**Fix a bug:** reproduce it in the app, fix it in its zone, add a test beside the code, upstream.

**Extract a feature:** build it in a freshly scaffolded, committed app until it works. Then
`git add -AN` (the diff omits untracked files otherwise) and `git diff` the scaffold commit: reusable
logic and SDK calls become `package/`; router mounts, web features, workflow classes and `tools/`
scripts become `template/` at their app paths. Create the shell with
`mistral apps capability init <id>` and follow
[`write-mistral-apps-capability`](../write-mistral-apps-capability/SKILL.md) for the manifest and
zones.

## Upstream it

```bash
# in the app
P=.mistral/repositories/mistralai-capabilities
git -C "$P" add -AN
git diff --relative="$P" -- "$P" > /tmp/cap.patch

# in a fresh registry clone, on a branch off main
git apply /tmp/cap.patch
```

In the clone:

1. Record the change under `[Unreleased]` in the capability's `CHANGELOG.md`, with anything a
   consuming app must do under `### Breaking`.
2. Pass the gate in [`REGISTRY.md`](REGISTRY.md#the-gate).
3. Run `thermo-nuclear-code-quality-review` over the diff.
4. Open the PR, titled as a Conventional Commit scoped to the capabilities: `fix(api,postgres): …`,
   `chore!: …` when breaking.

Done when the PR is open, the gate is green, and the `CHANGELOG.md` entry tells a consuming app what
to do. Once it merges, `mistral apps registry update --ref <new-tag>` in the app and check the
subtree carries the merged version.
