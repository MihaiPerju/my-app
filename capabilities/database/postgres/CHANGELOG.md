# Changelog — `@mistralai-capabilities/database-postgres`

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The framework uses **lockstep versioning**: every `@mistralai-capabilities/*` package shares
one version, stamped from the release git tag at publish time. Record changes
under `[Unreleased]`; they roll into the next tagged release. Note anything a
consuming app must change to upgrade under **Breaking** — `mistral apps capability
update` points the planning agent at this file.

## [Unreleased]

### Added

- A `database` declaration, so the CLI adds a managed Postgres module to apps.json and deploy provisions it.
- `env.db` builds the database URL from `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `POSTGRES_SSL_MODE` when `DATABASE_URL` is unset, which is how managed Postgres on Mistral Apps passes the connection.
