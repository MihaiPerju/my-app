{{/*
=============================================================================
common.probe — render one probe, layering probes.<kind> over the probes.* base.
=============================================================================
Call with (dict "kind" "liveness" "probes" $wl.probes).

Layered rather than per-probe-only so a workload that sets just `probes.path` keeps
getting liveness + readiness on it, which is what web and any future subchart do. A
workload that needs the probes to differ — the api, which points them at
/api/health/live and /api/health/ready — adds a `liveness:` / `readiness:` sub-map and
overrides only the keys it cares about.

startupProbe renders ONLY when `probes.startup` exists, so no workload gains one by
accident. Every optional field is emitted only when set, which keeps an untouched
workload's manifest byte-identical and stops this change rolling web's pods.
*/}}
{{- define "common.probe" -}}
{{- $probes := .probes -}}
{{- $base := omit $probes "enabled" "startup" "liveness" "readiness" -}}
{{- $spec := merge (deepCopy (get $probes .kind | default dict)) $base -}}
{{- if or (eq .kind "liveness") (eq .kind "readiness") (hasKey $probes .kind) -}}
{{ .kind }}Probe:
  httpGet:
    path: {{ required (printf "probes.%s.path (or probes.path) is required" .kind) $spec.path }}
    port: http
  {{- with $spec.initialDelaySeconds }}
  initialDelaySeconds: {{ . }}
  {{- end }}
  {{- with $spec.periodSeconds }}
  periodSeconds: {{ . }}
  {{- end }}
  {{- with $spec.timeoutSeconds }}
  timeoutSeconds: {{ . }}
  {{- end }}
  {{- with $spec.failureThreshold }}
  failureThreshold: {{ . }}
  {{- end }}
  {{- with $spec.successThreshold }}
  successThreshold: {{ . }}
  {{- end }}
{{- end }}
{{- end -}}
