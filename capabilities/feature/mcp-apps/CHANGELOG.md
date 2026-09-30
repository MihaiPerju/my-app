# Changelog — `@mistralai-capabilities/feature-mcp-apps`

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The framework uses **lockstep versioning**: every `@mistralai-capabilities/*` package shares
one version, stamped from the release git tag at publish time. Record changes
under `[Unreleased]`; they roll into the next tagged release. Note anything a
consuming app must change to upgrade under **Breaking** — `mistral apps capability
update` points the planning agent at this file.

## [Unreleased]

### Added

- A `routes` declaration of `/mcp` with `mcp: true`, so the CLI registers it as the app's MCP route and the gateway turns on client sign-in for it.
- `MCP_SERVER_URL` falls back to the platform-injected `__APPS_PUBLIC_ORIGIN` (or `__SPACES_PUBLIC_ORIGIN`) plus `/mcp`, so a deployed app registers its self-connector without extra configuration.
