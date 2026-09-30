# Changelog — `@mistralai-capabilities/backend-workflows`

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The framework uses **lockstep versioning**: every `@mistralai-capabilities/*` package shares
one version, stamped from the release git tag at publish time. Record changes
under `[Unreleased]`; they roll into the next tagged release. Note anything a
consuming app must change to upgrade under **Breaking** — `mistral apps capability
update` points the planning agent at this file.

## [Unreleased]

### Breaking

- The `workflow-deploy` command is removed. Deploy the worker with `mistral apps deploy`, which
  deploys the worker module marked `platform: "workflows"` as a managed workflow deployment named
  `<app>-<module>`, at the current commit, on the Mistral Cloud backend, and waits for it to roll
  out. The deployment is no longer named after `DEPLOYMENT_NAME`, so pass
  `DEPLOYMENT_NAME=<app>-<module>` to `workflow-start` to dispatch to it. In an existing app,
  edit the worker module in `apps.json`: add `"platform": "workflows"` and remove `build.target`.
  `mistral apps deploy` refuses the worker until both are done.

### Added

- `capability.json` marks the worker module `"platform": "workflows"`, so `mistral apps deploy`
  runs it as a managed workflow deployment.
