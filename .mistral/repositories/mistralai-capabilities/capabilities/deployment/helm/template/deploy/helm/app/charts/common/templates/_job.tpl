{{/*
=============================================================================
common.job — one-shot Job run as a pre-install/pre-upgrade helm hook.
=============================================================================
Call with (dict "root" $ "component" "init-migrations" "workload" $wl).

`$wl.hookWeight` orders this hook against its siblings. Helm parses the weight with
strconv.Atoi and SILENTLY falls back to 0 on any error — a stray space, a decimal
point or an int64 overflow all collapse the hook to weight 0 and run it first, with
no warning. So the weight is validated here and always emitted quoted.

hook-delete-policy keeps `hook-succeeded`: on failure Helm reaps the hooks that
already succeeded but leaves the failed one standing, which is the Job you want to
kubectl-describe. hook-output-log-policy streams that pod's logs into the helm
output before the resource is reaped on the next attempt.
*/}}
{{- define "common.job" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $wl := .workload -}}
{{- $g := $root.Values.global | default dict -}}
{{- $weight := $wl.hookWeight | toString -}}
{{- if not (regexMatch "^-?[0-9]+$" $weight) -}}
{{- fail (printf "common.job: component %q has hook weight %q, which Helm would silently read as 0; expected a plain integer" $component $weight) -}}
{{- end -}}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "common.componentName" (dict "root" $root "component" $component) }}
  labels:
    {{- include "common.componentLabels" (dict "root" $root "component" $component) | nindent 4 }}
  annotations:
    # post-install, NOT pre-install. Helm applies the regular manifest BETWEEN the pre-
    # and post-install phases, so a pre-install Job runs before the ServiceAccount it
    # names, the Secret it reads, and (when global.postgres.deploy=true) the database it
    # migrates all exist — a fresh `helm install` could never create the pod at all
    # ("serviceaccount not found"). It survived only because an upgrade finds those
    # already there from the previous revision. Upgrades keep pre-upgrade so migrations
    # still land before the new pods roll; only the install phase moves.
    "helm.sh/hook": post-install,pre-upgrade
    "helm.sh/hook-weight": {{ $weight | quote }}
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
    "helm.sh/hook-output-log-policy": hook-failed
spec:
  backoffLimit: {{ $wl.backoffLimit }}
  template:
    metadata:
      labels:
        {{- include "common.componentSelectorLabels" (dict "root" $root "component" $component) | nindent 8 }}
    spec:
      restartPolicy: Never
      serviceAccountName: {{ include "common.serviceAccountName" $root }}
      automountServiceAccountToken: {{ $g.serviceAccount.automountServiceAccountToken }}
      {{- include "common.imagePullSecrets" (dict "root" $root) | nindent 6 }}
      securityContext:
        {{- include "common.podSecurityContext" (dict "root" $root "workload" $wl) | nindent 8 }}
      containers:
        - name: {{ $component }}
          image: {{ include "common.image" (dict "root" $root "workload" $wl) }}
          imagePullPolicy: {{ include "common.imagePullPolicy" (dict "root" $root "workload" $wl) }}
          {{- with $wl.command }}
          command: {{ toYaml . | nindent 12 }}
          {{- end }}
          {{- with $wl.args }}
          args: {{ toYaml . | nindent 12 }}
          {{- end }}
          securityContext:
            {{- include "common.containerSecurityContext" (dict "root" $root "workload" $wl) | nindent 12 }}
          env:
            {{- include "common.staticEnv" (dict "workload" $wl) | nindent 12 }}
            {{- include "common.extraEnv" (dict "root" $root "component" $component) | nindent 12 }}
          resources:
            {{- toYaml $wl.resources | nindent 12 }}
          volumeMounts:
            {{- include "common.writableVolumeMounts" (dict "workload" $wl) | nindent 12 }}
      volumes:
        {{- include "common.writableVolumes" (dict "workload" $wl) | nindent 8 }}
      {{- with $wl.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $wl.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $wl.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end -}}
