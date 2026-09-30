# `@mistralai-capabilities/registry`

This package supplies the registry descriptor used by `mistral apps` to discover
public Mistral Apps capabilities.

Its only payload is `registry.json`. When configured with an npm registry source,
the CLI installs this package and reads that file to find the available capabilities
and the package sources used to install them.
