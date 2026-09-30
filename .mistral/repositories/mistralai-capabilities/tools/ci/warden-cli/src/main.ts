import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { Builtins, Cli, Command, Option, UsageError } from "clipanion";

type GitHubTokenRequestPayload = {
  app?: string;
  type: "github";
  repository: string;
  perms: string[];
};

type BitwardenTokenRequestPayload = {
  type: "bitwarden";
  secret_id: string;
};

type TokenRequestPayload = BitwardenTokenRequestPayload | GitHubTokenRequestPayload;

type JsonObject = Record<string, unknown>;

type RequestResult = {
  token: string;
  status: number;
  responseBody: unknown;
};

type OutputFormat = "raw" | "json" | "env";

const OUTPUT_FORMATS = new Set(["raw", "json", "env"] as const);

class RetryableWardenRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableWardenRequestError";
  }
}

function getRequiredWardenUrl(url?: string): string {
  const resolvedUrl = url ?? process.env.WARDEN_URL ?? process.env.WARDEN;
  if (!resolvedUrl || resolvedUrl.trim().length === 0) {
    throw new Error(
      "Missing Warden URL. Provide --url or set WARDEN_URL (or WARDEN).",
    );
  }

  return resolvedUrl.trim();
}

function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getAudience(audience: string | undefined, wardenUrl: string): string {
  return audience ?? process.env.WARDEN_AUDIENCE ?? wardenUrl;
}

function getAudienceFallbackBase(endpoint: string, wardenUrl?: string): string {
  if (wardenUrl) {
    return wardenUrl;
  }

  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function parsePerms(inputPerms: string[]): string[] {
  const perms = inputPerms
    .flatMap((perm) => perm.split(","))
    .map((perm) => perm.trim())
    .filter((perm) => perm.length > 0);

  const deduplicatedPerms = Array.from(new Set(perms));
  if (deduplicatedPerms.length === 0) {
    throw new Error("At least one permission is required. Use --perm.");
  }

  return deduplicatedPerms;
}

function parseRepository(repository: string): string {
  const normalizedRepository = repository.trim();
  if (!normalizedRepository) {
    throw new Error("Repository cannot be empty.");
  }

  return normalizedRepository;
}

function parseSecretId(secretId: string): string {
  const normalizedSecretId = secretId.trim();
  if (!normalizedSecretId) {
    throw new Error("Bitwarden secret id cannot be empty.");
  }

  if (normalizedSecretId === "*") {
    throw new Error("Bitwarden secret id must be explicit.");
  }

  return normalizedSecretId;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }

  return parsed;
}

function parseTimeoutMs(timeoutMs: string): number {
  return parsePositiveInteger(timeoutMs, "--timeout-ms");
}

function parseOutputFormat(format: string): OutputFormat {
  if (OUTPUT_FORMATS.has(format as OutputFormat)) {
    return format as OutputFormat;
  }

  throw new Error("--format must be one of: raw, json, env.");
}

function parseOidcTimeoutMs(timeoutMs: string): number {
  return parsePositiveInteger(timeoutMs, "--oidc-timeout-ms");
}

function parseRetries(retries: string): number {
  return parseNonNegativeInteger(retries, "--retries");
}

function parseRetryDelayMs(retryDelayMs: string): number {
  return parsePositiveInteger(retryDelayMs, "--retry-delay-ms");
}

function requestBuildkiteOidcToken(
  audience: string,
  timeoutMs: number,
): string {
  try {
    const token = execFileSync(
      "buildkite-agent",
      ["oidc", "request-token", "--audience", audience],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      },
    ).trim();

    if (!token) {
      throw new Error("buildkite-agent returned an empty token");
    }

    return token;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        "Failed to request OIDC token from Buildkite. " +
          "Pass --oidc-token to provide one explicitly. " +
          `Details: ${error.message}`,
      );
    }

    throw new Error(
      "Failed to request OIDC token from Buildkite. " +
        "Pass --oidc-token to provide one explicitly.",
    );
  }
}

function getOidcToken(
  oidcToken: string | undefined,
  audience: string,
  timeoutMs: number,
): string {
  if (oidcToken && oidcToken.trim().length > 0) {
    return oidcToken.trim();
  }

  return requestBuildkiteOidcToken(audience, timeoutMs);
}

function parseJsonIfPossible(rawBody: string): unknown {
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function extractTokenFromBody(body: unknown): string | null {
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!body || typeof body !== "object") {
    return null;
  }

  const objectBody = body as JsonObject;
  const tokenCandidate = objectBody.token;
  if (typeof tokenCandidate === "string" && tokenCandidate.trim().length > 0) {
    return tokenCandidate;
  }

  const accessTokenCandidate = objectBody.access_token;
  if (
    typeof accessTokenCandidate === "string" &&
    accessTokenCandidate.trim().length > 0
  ) {
    return accessTokenCandidate;
  }

  return null;
}

function formatServerError(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const objectBody = body as JsonObject;

  const message =
    typeof objectBody.message === "string"
      ? objectBody.message.trim()
      : typeof objectBody.error === "string"
        ? objectBody.error.trim()
        : null;

  if (!message) {
    return null;
  }

  const lines = [message];

  if (typeof objectBody.app === "string") {
    lines.push(`  App: ${objectBody.app}`);
  }

  if (
    Array.isArray(objectBody.registeredApps) &&
    objectBody.registeredApps.length > 0
  ) {
    lines.push(`  Registered apps: ${objectBody.registeredApps.join(", ")}`);
  }

  if (typeof objectBody.repository === "string") {
    lines.push(`  Repository: ${objectBody.repository}`);
  }

  if (typeof objectBody.secret_id === "string") {
    lines.push(`  Bitwarden secret id: ${objectBody.secret_id}`);
  }

  if (Array.isArray(objectBody.requestedPerms)) {
    lines.push(`  Requested permissions: ${objectBody.requestedPerms.join(", ")}`);
  }

  if (Array.isArray(objectBody.allowedPerms)) {
    lines.push(`  Allowed permissions: ${objectBody.allowedPerms.length > 0 ? objectBody.allowedPerms.join(", ") : "(none)"}`);
  }

  const principal = objectBody.principal;
  if (principal && typeof principal === "object") {
    const p = principal as JsonObject;
    if (typeof p.subject === "string") {
      lines.push(`  Subject: ${p.subject}`);
    }
    if (typeof p.issuer === "string") {
      lines.push(`  Issuer: ${p.issuer}`);
    }
    if (p.claims && typeof p.claims === "object") {
      lines.push(`  Claims: ${JSON.stringify(p.claims)}`);
    }
  }

  if (lines.length > 1)
    lines.splice(1, 0, "");

  return lines.join("\n");
}

async function requestWardenToken(params: {
  endpoint: string;
  oidcToken: string;
  payload: TokenRequestPayload;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  privateAccessToken?: string;
}): Promise<RequestResult> {
  const maxAttempts = params.retries + 1;
  let lastRetryableError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestWardenTokenOnce(params);
    } catch (error) {
      if (!isRetryableWardenRequestError(error)) {
        throw error;
      }

      lastRetryableError = error;
      if (attempt === maxAttempts) {
        break;
      }

      const delayMs = params.retryDelayMs * attempt;
      process.stderr.write(
        `Warden token request failed (attempt ${attempt}/${maxAttempts}); ` +
          `retrying in ${delayMs}ms. ${formatErrorForMessage(error)}\n`,
      );
      await sleep(delayMs);
    }
  }

  throw new UsageError(
    `Failed to request Warden token after ${maxAttempts} attempts. ` +
      formatErrorForMessage(lastRetryableError),
  );
}

async function requestWardenTokenOnce(params: {
  endpoint: string;
  oidcToken: string;
  payload: TokenRequestPayload;
  timeoutMs: number;
  privateAccessToken?: string;
}): Promise<RequestResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.oidcToken}`,
    "Content-Type": "application/json",
  };

  if (params.privateAccessToken) {
    headers["x-private-access"] = params.privateAccessToken;
  }

  let response: Response;
  try {
    response = await fetch(params.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(params.payload),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    if (isRetryableFetchError(error)) {
      throw new RetryableWardenRequestError(formatErrorForMessage(error), {
        cause: error,
      });
    }

    throw error;
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    if (isRetryableFetchError(error)) {
      throw new RetryableWardenRequestError(formatErrorForMessage(error), {
        cause: error,
      });
    }

    throw error;
  }
  const parsedBody = parseJsonIfPossible(rawBody);

  if (!response.ok) {
    const errorMessage =
      formatServerError(parsedBody) ??
      `HTTP ${response.status}: ${rawBody || "request failed"}`;
    throw new UsageError(errorMessage);
  }

  const token = extractTokenFromBody(parsedBody);
  if (!token) {
    throw new Error(
      "Warden response did not include a token field. " +
        "Expected token/access_token or a plain text token.",
    );
  }

  return {
    token,
    status: response.status,
    responseBody: parsedBody,
  };
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    (error instanceof TypeError && error.message.includes("fetch failed"))
  );
}

function isRetryableWardenRequestError(
  error: unknown,
): error is RetryableWardenRequestError {
  return error instanceof RetryableWardenRequestError;
}

function formatErrorForMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function formatOutput(params: {
  audience: string;
  endpoint: string;
  envVar: string;
  format: OutputFormat;
  payload: TokenRequestPayload;
  result: RequestResult;
}): string {
  if (params.format === "raw") {
    return `${params.result.token}\n`;
  }

  if (params.format === "env") {
    return `${params.envVar}=${params.result.token}\n`;
  }

  return `${JSON.stringify(
    {
      audience: params.audience,
      endpoint: params.endpoint,
      request: params.payload,
      status: params.result.status,
      token: params.result.token,
      response: params.result.responseBody,
    },
    null,
    2,
  )}\n`;
}

class GithubTokenCommand extends Command {
  static paths = [Command.Default, ["github"]];

  static usage = Command.Usage({
    category: "Warden",
    description: "Request an ephemeral GitHub token from Warden",
    examples: [
      [
        "Request a token with one permission",
        "$0 --url https://warden.globalaegis.net --repository dashboard --perm contents:read",
      ],
      [
        "Request a token with multiple permissions",
        "$0 github --repository dashboard --perm contents:read --perm pull_requests:write",
      ],
      [
        "Emit an env assignment",
        "$0 github --repository dashboard --perm contents:read --format env --env-var GH_TOKEN",
      ],
      [
        "Bypass Buildkite OIDC call by supplying token",
        '$0 github --repository dashboard --perm contents:read --oidc-token "$OIDC_TOKEN" --format json',
      ],
      [
        "Use endpoint directly without --url",
        "$0 github --endpoint https://warden.globalaegis.net/token --repository dashboard --perm contents:read",
      ],
    ],
  });

  repository = Option.String("-r,--repository", {
    description: "GitHub repository to request access for",
    required: true,
  });

  app = Option.String("--app", {
    description:
      "Registered GitHub App name to mint the token with (defaults to the server's default app)",
  });

  perms = Option.Array("-p,--perm", {
    description:
      "Requested GitHub permission (repeatable, comma-separated values are supported)",
    required: true,
  });

  url = Option.String("-u,--url", {
    description: "Warden base URL (defaults to WARDEN_URL, then WARDEN)",
  });

  endpoint = Option.String("-e,--endpoint", {
    description: "Exact request endpoint (defaults to --url value)",
  });

  audience = Option.String("-a,--audience", {
    description:
      "OIDC audience for buildkite-agent (defaults to WARDEN_AUDIENCE, then --url or --endpoint origin)",
  });

  oidcToken = Option.String("--oidc-token", {
    description:
      "OIDC token override (skip buildkite-agent oidc request-token)",
  });

  oidcTimeoutMs = Option.String("--oidc-timeout-ms", "10000", {
    description:
      "Timeout for buildkite-agent oidc request-token in milliseconds",
  });

  timeoutMs = Option.String("--timeout-ms", "10000", {
    description: "HTTP timeout in milliseconds",
  });

  retries = Option.String("--retries", "2", {
    description: "Retry attempts for transient Warden network/fetch failures",
  });

  retryDelayMs = Option.String("--retry-delay-ms", "1000", {
    description: "Base retry delay for Warden HTTP requests in milliseconds",
  });

  format = Option.String("--format", "raw", {
    description: "Output format: raw (token), json, or env",
  });

  envVar = Option.String("--env-var", "GITHUB_TOKEN", {
    description: "Variable name used when --format env",
  });

  privateAccessToken = Option.String("--private-access-token", {
    description:
      "Private access token for Cloudflare-protected endpoints (sent as x-private-access header)",
  });

  output = Option.String("-o,--output", {
    description:
      "Write the token to this file instead of stdout",
  });

  async execute(): Promise<number> {
    const format = parseOutputFormat(this.format);
    const configuredWardenUrl = this.url ? normalizeUrl(this.url) : undefined;
    const endpoint = this.endpoint
      ? normalizeUrl(this.endpoint)
      : normalizeUrl(getRequiredWardenUrl(this.url));
    const audience = getAudience(
      this.audience,
      getAudienceFallbackBase(endpoint, configuredWardenUrl),
    );
    const oidcToken = getOidcToken(
      this.oidcToken,
      audience,
      parseOidcTimeoutMs(this.oidcTimeoutMs),
    );

    const payload: TokenRequestPayload = {
      type: "github",
      repository: parseRepository(this.repository),
      perms: parsePerms(this.perms),
      ...(this.app && this.app.trim().length > 0
        ? { app: this.app.trim() }
        : {}),
    };

    const result = await requestWardenToken({
      endpoint,
      oidcToken,
      payload,
      timeoutMs: parseTimeoutMs(this.timeoutMs),
      retries: parseRetries(this.retries),
      retryDelayMs: parseRetryDelayMs(this.retryDelayMs),
      privateAccessToken: this.privateAccessToken,
    });

    const output = formatOutput({
      audience,
      endpoint,
      envVar: this.envVar,
      format,
      payload,
      result,
    });

    if (this.output) {
      writeFileSync(this.output, output);
    } else {
      this.context.stdout.write(output);
    }
    return 0;
  }
}

class BitwardenTokenCommand extends Command {
  static paths = [["bitwarden"]];

  static usage = Command.Usage({
    category: "Warden",
    description: "Request a Bitwarden secret value from Warden",
    examples: [
      [
        "Request a Bitwarden secret",
        "$0 bitwarden --url https://warden.globalaegis.net --secret-id bitwarden-secret-id",
      ],
      [
        "Emit an env assignment",
        "$0 bitwarden --secret-id bitwarden-secret-id --format env --env-var BITWARDEN_TOKEN",
      ],
      [
        "Bypass Buildkite OIDC call by supplying token",
        '$0 bitwarden --secret-id bitwarden-secret-id --oidc-token "$OIDC_TOKEN" --format json',
      ],
      [
        "Use endpoint directly without --url",
        "$0 bitwarden --endpoint https://warden.globalaegis.net/token --secret-id bitwarden-secret-id",
      ],
    ],
  });

  secretId = Option.String("--secret-id", {
    description: "Bitwarden Secrets Manager secret id to request",
    required: true,
  });

  url = Option.String("-u,--url", {
    description: "Warden base URL (defaults to WARDEN_URL, then WARDEN)",
  });

  endpoint = Option.String("-e,--endpoint", {
    description: "Exact request endpoint (defaults to --url value)",
  });

  audience = Option.String("-a,--audience", {
    description:
      "OIDC audience for buildkite-agent (defaults to WARDEN_AUDIENCE, then --url or --endpoint origin)",
  });

  oidcToken = Option.String("--oidc-token", {
    description:
      "OIDC token override (skip buildkite-agent oidc request-token)",
  });

  oidcTimeoutMs = Option.String("--oidc-timeout-ms", "10000", {
    description:
      "Timeout for buildkite-agent oidc request-token in milliseconds",
  });

  timeoutMs = Option.String("--timeout-ms", "10000", {
    description: "HTTP timeout in milliseconds",
  });

  retries = Option.String("--retries", "2", {
    description: "Retry attempts for transient Warden network/fetch failures",
  });

  retryDelayMs = Option.String("--retry-delay-ms", "1000", {
    description: "Base retry delay for Warden HTTP requests in milliseconds",
  });

  format = Option.String("--format", "raw", {
    description: "Output format: raw (token), json, or env",
  });

  envVar = Option.String("--env-var", "BITWARDEN_TOKEN", {
    description: "Variable name used when --format env",
  });

  privateAccessToken = Option.String("--private-access-token", {
    description:
      "Private access token for Cloudflare-protected endpoints (sent as x-private-access header)",
  });

  output = Option.String("-o,--output", {
    description:
      "Write the token to this file instead of stdout",
  });

  async execute(): Promise<number> {
    const format = parseOutputFormat(this.format);
    const configuredWardenUrl = this.url ? normalizeUrl(this.url) : undefined;
    const endpoint = this.endpoint
      ? normalizeUrl(this.endpoint)
      : normalizeUrl(getRequiredWardenUrl(this.url));
    const audience = getAudience(
      this.audience,
      getAudienceFallbackBase(endpoint, configuredWardenUrl),
    );
    const oidcToken = getOidcToken(
      this.oidcToken,
      audience,
      parseOidcTimeoutMs(this.oidcTimeoutMs),
    );

    const payload: TokenRequestPayload = {
      type: "bitwarden",
      secret_id: parseSecretId(this.secretId),
    };

    const result = await requestWardenToken({
      endpoint,
      oidcToken,
      payload,
      timeoutMs: parseTimeoutMs(this.timeoutMs),
      retries: parseRetries(this.retries),
      retryDelayMs: parseRetryDelayMs(this.retryDelayMs),
      privateAccessToken: this.privateAccessToken,
    });

    const output = formatOutput({
      audience,
      endpoint,
      envVar: this.envVar,
      format,
      payload,
      result,
    });

    if (this.output) {
      writeFileSync(this.output, output);
    } else {
      this.context.stdout.write(output);
    }
    return 0;
  }
}

const cli = new Cli({
  binaryLabel: "Warden CLI",
  binaryName: "warden-cli",
  binaryVersion: "0.1.0",
});

cli.register(GithubTokenCommand);
cli.register(BitwardenTokenCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

void cli.runExit(process.argv.slice(2), Cli.defaultContext);
