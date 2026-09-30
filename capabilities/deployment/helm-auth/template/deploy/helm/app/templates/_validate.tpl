{{/*
Fail-closed preflight. Rendering stops rather than shipping a configuration that
exposes the API without the authenticating gateway in front of it.

Must be INCLUDED from a rendered manifest — Helm never executes the top level of a
`_`-prefixed partial, so a bare `fail` in this file would silently never run.
*/}}
{{- define "common.validateAuth" -}}
{{- if and .Values.ingress.enabled (not .Values.gateway.enabled) }}
{{- fail "ingress.enabled requires gateway.enabled: routing to the API directly bypasses the OIDC login flow" }}
{{- end }}
{{- if and .Values.gateway.enabled (eq (.Values.auth.oidc.clientSecretKey | default "") (.Values.auth.oidc.sessionSecretKey | default "x")) }}
{{- fail "auth.oidc.sessionSecretKey must differ from auth.oidc.clientSecretKey: the cookie-signing key must not also be IdP credentials" }}
{{- end }}
{{- end -}}
