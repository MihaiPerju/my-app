interface Policy {
  label: string;
  pattern: RegExp;
}

const policies: Policy[] = [
  {
    label: "Gemfury reference",
    pattern: /(?:\bgemfury\b|(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*fury\.io(?=$|[^a-z0-9.-]))/i,
  },
  {
    label: "Cloudsmith reference",
    pattern:
      /(?:\bcloudsmith\b(?!\.io\b)|(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*cloudsmith\.io(?=$|[^a-z0-9.-]))/i,
  },
  {
    label: "Socket registry",
    pattern: /(?:^|[^a-z0-9-])socket-registry(?=$|[^a-z0-9-])/i,
  },
  {
    label: "Mistral Slack workspace",
    pattern: /(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*mistralai\.slack\.com(?=$|[^a-z0-9.-])/i,
  },
  {
    label: "Mistral GitHub organization link",
    pattern: /(?:^|[^a-z0-9.-])github\.com\/mistralai(?:\/|(?=$|[\s"'<>)]))/i,
  },
  {
    label: "internal URL hostname",
    // Require a URL authority so dotted code identifiers such as
    // `api.routers.api.internal.health` are not mistaken for hostnames. Google's documented GCE
    // metadata endpoint is public API surface despite its reserved `.internal` suffix.
    pattern:
      /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@"'<>]+@)?(?!(?:metadata\.google\.internal)(?=[:/?#\s"'<>]|$))(?:(?:[a-z0-9-]+\.)+(?:internal|intranet|corp)|(?:internal|intranet)(?:\.[a-z0-9-]+)+)(?=[:/?#\s"'<>]|$)/i,
  },
  {
    label: "Mistral registry-token environment variable",
    pattern: /(?:^|[^A-Za-z0-9_])MISTRAL_REGISTRY_TOKEN(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "Mistral registry-user environment variable",
    pattern: /(?:^|[^A-Za-z0-9_])MISTRAL_REGISTRY_USER(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "Gemfury pull-token environment variable",
    pattern: /(?:^|[^A-Za-z0-9_])GEMFURY_PULL_TOKEN(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "npm authentication-token environment variable",
    pattern: /(?:^|[^A-Za-z0-9_])NODE_AUTH_TOKEN(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "Python registry-user environment variable",
    pattern: /(?:^|[^A-Za-z0-9_])REGISTRY_PY_USER(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "uv named-index username environment variable",
    pattern:
      /(?:^|[^A-Za-z0-9_])UV_INDEX_[A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?_USERNAME(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "uv named-index password environment variable",
    pattern:
      /(?:^|[^A-Za-z0-9_])UV_INDEX_[A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?_PASSWORD(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "npm authentication-token config key",
    // Match npmrc assignment syntax, not prose that merely discusses authentication tokens.
    pattern: /(?:^|[\r\n])[\t ]*(?:[^\s=]+:)?_authToken[\t ]*=/i,
  },
];

export function forbiddenReferenceLabels(text: string): string[] {
  return policies.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}
