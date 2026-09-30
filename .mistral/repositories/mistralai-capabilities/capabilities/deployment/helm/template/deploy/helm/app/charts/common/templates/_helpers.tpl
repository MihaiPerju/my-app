{{/*
=============================================================================
Naming / labels
=============================================================================
Shared names derive from .Release.Name (identical across the parent umbrella
chart and every subchart), NOT from .Chart.Name. This guarantees a name
computed in one subchart matches the same name referenced from another
subchart or the parent.
*/}}

{{/*
common.name — the product name. Prefer the global override, else the app name the
chart was scaffolded with (global.appName), else a neutral fallback so a chart
rendered without this repo's values still produces a legal name.
*/}}
{{- define "common.name" -}}
{{- $g := .Values.global | default dict -}}
{{- default (default "app" $g.appName) $g.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
common.fullname — release-scoped base name, stable across all charts.
*/}}
{{- define "common.fullname" -}}
{{- $g := .Values.global | default dict -}}
{{- if $g.fullnameOverride -}}
{{- $g.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "common.deploymentName" -}}
{{- $g := .Values.global | default dict -}}
{{- default (include "common.fullname" .) $g.deploymentName -}}
{{- end -}}

{{/*
common.chart — chart-version label. Uses the including chart's own Chart data.
*/}}
{{- define "common.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
common.labels — labels shared by every object.
*/}}
{{- define "common.labels" -}}
helm.sh/chart: {{ include "common.chart" . }}
{{ include "common.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "common.name" . }}
{{- $g := .Values.global | default dict -}}
{{- with $g.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "common.selectorLabels" -}}
app.kubernetes.io/name: {{ include "common.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-workload labels. Call with (dict "root" $ "component" "api").
*/}}
{{- define "common.componentLabels" -}}
{{ include "common.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "common.componentSelectorLabels" -}}
{{ include "common.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
common.componentName — the release-derived name of a component resource.
Call with (dict "root" $ "component" "api").
*/}}
{{- define "common.componentName" -}}
{{- printf "%s-%s" (include "common.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
=============================================================================
Stable shared-name helpers (release-derived so parent + subcharts agree)
=============================================================================
*/}}

{{/*
ServiceAccount name. Honors global.serviceAccount.name override.
*/}}
{{- define "common.serviceAccountName" -}}
{{- $g := .Values.global | default dict -}}
{{- $sa := $g.serviceAccount | default dict -}}
{{- if $sa.create -}}
{{- default (include "common.fullname" .) $sa.name -}}
{{- else -}}
{{- default "default" $sa.name -}}
{{- end -}}
{{- end -}}

{{/*
Secret name that workloads reference. Honors global.secrets.name and the
externalSecrets.targetName the same way the old helper did.
*/}}
{{- define "common.secretName" -}}
{{- $g := .Values.global | default dict -}}
{{- $secrets := $g.secrets | default dict -}}
{{- $ext := $secrets.externalSecrets | default dict -}}
{{- if $ext.enabled -}}
{{- default (default (printf "%s-secrets" (include "common.fullname" .)) $secrets.name) $ext.targetName -}}
{{- else -}}
{{- default (printf "%s-secrets" (include "common.fullname" .)) $secrets.name -}}
{{- end -}}
{{- end -}}

{{/*
Cross-service Service names (release-derived).
*/}}
{{- define "common.apiServiceName" -}}
{{- printf "%s-api" (include "common.fullname" .) -}}
{{- end -}}

{{- define "common.postgresName" -}}
{{- printf "%s-postgres" (include "common.fullname" .) -}}
{{- end -}}

{{/*
=============================================================================
Image / security-context / pull-secret helpers (read global config)
=============================================================================
*/}}

{{/*
Fully-qualified image reference for a workload.
Call with (dict "root" $ "workload" .Values).
Registry/tag defaults come from global.image; per-workload repo/tag override
from the subchart's own values.
*/}}
{{- define "common.image" -}}
{{- $root := .root -}}
{{- $wl := .workload -}}
{{- $g := $root.Values.global | default dict -}}
{{- $gimg := $g.image | default dict -}}
{{- $registry := $gimg.registry -}}
{{- $repo := $wl.image.repository -}}
{{- $tag := default $gimg.tag $wl.image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{- define "common.imagePullPolicy" -}}
{{- $root := .root -}}
{{- $wl := .workload -}}
{{- $g := $root.Values.global | default dict -}}
{{- $gimg := $g.image | default dict -}}
{{- default $gimg.pullPolicy $wl.image.pullPolicy -}}
{{- end -}}

{{/*
imagePullSecrets block. Merges explicit global list with a chart-created credential.
Call with (dict "root" $).
*/}}
{{- define "common.imagePullSecrets" -}}
{{- $root := .root -}}
{{- $g := $root.Values.global | default dict -}}
{{- $names := list -}}
{{- range ($g.imagePullSecrets | default list) -}}
{{- $names = append $names .name -}}
{{- end -}}
{{- $creds := $g.imageCredentials | default dict -}}
{{- if $creds.create -}}
{{- $names = append $names (default (printf "%s-registry" (include "common.fullname" $root)) $creds.name) -}}
{{- end -}}
{{- if $names -}}
imagePullSecrets:
{{- range $names }}
  - name: {{ . }}
{{- end }}
{{- end -}}
{{- end -}}

{{/*
Pod-level securityContext. Merges shared global default with per-workload override.
Call with (dict "root" $ "workload" .Values).
*/}}
{{- define "common.podSecurityContext" -}}
{{- $g := .root.Values.global | default dict -}}
{{- $base := $g.podSecurityContext | default dict -}}
{{- $override := .workload.podSecurityContext | default dict -}}
{{- toYaml (mergeOverwrite (deepCopy $base) $override) -}}
{{- end -}}

{{/*
Container-level securityContext. Merges shared global default with per-workload override.
*/}}
{{- define "common.containerSecurityContext" -}}
{{- $g := .root.Values.global | default dict -}}
{{- $base := $g.containerSecurityContext | default dict -}}
{{- $override := .workload.containerSecurityContext | default dict -}}
{{- toYaml (mergeOverwrite (deepCopy $base) $override) -}}
{{- end -}}

{{/*
writableVolumes -> emptyDir(Memory) volume definitions (satisfies readOnlyRootFilesystem).
Call with (dict "workload" .Values).
*/}}
{{- define "common.writableVolumes" -}}
{{- range .workload.writableVolumes }}
- name: {{ .name }}
  emptyDir:
    medium: Memory
{{- end }}
{{- end -}}

{{- define "common.writableVolumeMounts" -}}
{{- range .workload.writableVolumes }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
{{- end }}
{{- end -}}

{{/*
Static (non-secret) env vars from a workload's `env` map.
Call with (dict "workload" .Values).
*/}}
{{- define "common.staticEnv" -}}
{{- range $k, $v := .workload.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{/*
=============================================================================
Secret / database env helpers (read global config)
=============================================================================
*/}}

{{/*
DATABASE_URL env, derived from in-chart postgres or the external secret.
Call with (dict "root" $).

Empty unless the postgres capability is in the app's selection: the umbrella values render
`global.postgres.enabled` only then, and referencing the `database-url` secret key in a
workload whose chart never defines it leaves the container in CreateContainerConfigError.
*/}}
{{- define "common.databaseEnv" -}}
{{- $root := .root -}}
{{- $g := $root.Values.global | default dict -}}
{{- $pg := $g.postgres | default dict -}}
{{- if and $pg.enabled $pg.deploy }}
- name: POSTGRES_HOST
  value: {{ include "common.postgresName" $root | quote }}
- name: POSTGRES_PORT
  value: {{ $pg.service.port | quote }}
- name: POSTGRES_USER
  value: {{ $pg.auth.username | quote }}
- name: POSTGRES_DB
  value: {{ $pg.auth.database | quote }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "common.secretName" $root }}
      key: {{ $pg.auth.passwordSecretKey }}
- name: DATABASE_URL
  value: {{ printf "postgres://%s:$(POSTGRES_PASSWORD)@%s:%v/%s" $pg.auth.username (include "common.postgresName" $root) $pg.service.port $pg.auth.database | quote }}
{{- else if $pg.enabled }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "common.secretName" $root }}
      key: {{ $g.secrets.keys.databaseUrl }}
{{- end }}
{{- end -}}

{{/*
Mistral API key + shared application secrets, all via secretKeyRef.
Call with (dict "root" $).
*/}}
{{- define "common.mistralSecretEnv" -}}
{{- $root := .root -}}
{{- $g := $root.Values.global | default dict -}}
{{- $secret := include "common.secretName" $root -}}
{{- $keys := $g.secrets.keys -}}
- name: MISTRAL_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.mistralApiKey }}
      optional: true
{{- end -}}

{{/*
Connector credential secrets (all optional; via secretKeyRef).
Call with (dict "root" $).
*/}}
{{- define "common.connectorSecretEnv" -}}
{{- $root := .root -}}
{{- $g := $root.Values.global | default dict -}}
{{- $secret := include "common.secretName" $root -}}
{{- $keys := $g.secrets.keys -}}
- name: GITHUB_CONNECTOR_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.githubConnectorToken }}
      optional: true
- name: SLACK_CONNECTOR_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.slackConnectorToken }}
      optional: true
- name: NOTION_CONNECTOR_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $keys.notionConnectorToken }}
      optional: true
{{- end -}}

{{/*
Chat: which agent the /chat mount fronts. Call with (dict "root" $).

Chat authenticates on MISTRAL_API_KEY, which `common.mistralSecretEnv` already
supplies, so nothing here carries a credential or names a tenant.

Nothing here may be emitted empty. The app types these as `str` with working
defaults, so "" is a value and not an absence: an empty agent name reaches the
agents API as a name it cannot resolve. Hence the `with` guards.
*/}}
{{- define "common.vibeAgentsEnv" -}}
{{- $root := .root -}}
{{- $g := $root.Values.global | default dict -}}
{{- $va := $g.vibeAgents | default dict -}}
{{- with $va.agentName }}
- name: VIBE_AGENTS_AGENT_NAME
  value: {{ . | quote }}
{{- end }}
{{- with $va.applicationName }}
- name: VIBE_AGENTS_APPLICATION_NAME
  value: {{ . | quote }}
{{- end }}
{{- with $va.timeoutSeconds }}
- name: VIBE_AGENTS_TIMEOUT_SECONDS
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/*
RBAC: the bootstrap admin list, from one global value so the init Job that seeds
the admins and the API that protects them can never drift apart. Only those two
receive it; no other workload needs the admins' identities. Also refuses to
render an API running the `allow_all` dev policy. Call with (dict "root" $ "component" $component).
*/}}
{{- define "common.customRbacEnv" -}}
{{- $root := .root -}}
{{- $g := $root.Values.global | default dict -}}
{{- $customRbac := $g.customRbac | default dict -}}
{{- if and (eq .component "api") (eq (toString (($root.Values.env | default dict).CUSTOM_RBAC_POLICY)) "allow_all") }}
{{- fail "api.env.CUSTOM_RBAC_POLICY=allow_all is dev god-mode (every caller is admin) and must not be deployed; use pg" }}
{{- end }}
{{- if or (eq .component "api") (eq .component "init-custom-rbac") }}
{{- with $customRbac.bootstrapAdmins }}
- name: CUSTOM_RBAC_BOOTSTRAP_ADMINS
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
=============================================================================
Per-service EXTRA env
=============================================================================
Returns the service-specific env block (in addition to staticEnv) for a
component. Call with (dict "root" $ "component" "api").
Cross-service URLs use release-derived Service names + global config.
*/}}
{{- define "common.extraEnv" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $g := $root.Values.global | default dict -}}
{{- $ingress := $g.ingress | default dict -}}
{{- $observability := $g.observability | default dict -}}
{{- $host := default (printf "%s.%s" (default "app" $g.appName) $g.baseDomain) $ingress.host -}}
{{- /* The worker refuses to start without this ("DEPLOYMENT_NAME is required"), and it
       names the worker the Mistral-hosted scheduler dispatches to, so it must stay
       stable for the life of a deployment and differ between them. */ -}}
{{- if or (eq $component "api") (eq $component "workflows") (hasPrefix "init-" $component) }}
- name: DEPLOYMENT_NAME
  value: {{ include "common.deploymentName" $root | quote }}
{{- end }}
{{- if and (or (eq $component "api") (hasPrefix "init-" $component)) $observability.mistralOtlpTracesEndpoint }}
- name: MISTRAL_OTLP_TRACES_ENDPOINT
  value: {{ $observability.mistralOtlpTracesEndpoint | quote }}
{{- end }}
{{- if eq $component "api" }}
- name: CORS_ORIGIN
  value: {{ printf "https://%s" $host | quote }}
{{- if (default false ($g.api | default dict).mcpAppsEnabled) }}
- name: MCP_SERVER_URL
  value: {{ printf "http://%s:%v/mcp" (include "common.apiServiceName" $root) $g.api.service.port | quote }}
{{- end }}
{{ include "common.databaseEnv" (dict "root" $root) }}
{{ include "common.mistralSecretEnv" (dict "root" $root) }}
{{ include "common.vibeAgentsEnv" (dict "root" $root) }}
{{ include "common.customRbacEnv" (dict "root" $root "component" $component) }}
{{- else if eq $component "workflows" }}
{{ include "common.databaseEnv" (dict "root" $root) }}
{{ include "common.mistralSecretEnv" (dict "root" $root) }}
{{ include "common.connectorSecretEnv" (dict "root" $root) }}
{{- else if hasPrefix "init-" $component }}
{{/* One Job per init step, each named init-<step>. Every step gets the same env: the
     steps that touch storage need DATABASE_URL, the guardrail seed embeds through the
     Mistral API, the agents step registers with the vibe_agents control plane, and
     narrowing per step would couple this helper to the step list. */}}
{{ include "common.databaseEnv" (dict "root" $root) }}
{{ include "common.mistralSecretEnv" (dict "root" $root) }}
{{ include "common.vibeAgentsEnv" (dict "root" $root) }}
{{ include "common.customRbacEnv" (dict "root" $root "component" $component) }}
{{- end }}
{{- end -}}
