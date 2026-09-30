{{/*
=============================================================================
common.deployment — generic Deployment for every service workload.
=============================================================================
Call with (dict "root" $ "component" "api" "workload" .Values).
Reproduces the full deployment structure: replicas/autoscaling guard, selector/
labels, serviceAccount, automountServiceAccountToken, imagePullSecrets, pod+
container securityContext, command/args, ports (gated on ports.enabled / containerPort),
env assembly (staticEnv + per-service extras), probes (gated on probes.enabled, see common.probe),
optional lifecycle + terminationGracePeriodSeconds, resources, writable volumes/mounts,
nodeSelector/tolerations/affinity.

`lifecycle` is a verbatim passthrough rather than a preStop-shaped schema: draining is the
api's concern, and `common` should not grow a field the other workloads never set.
*/}}
{{- define "common.deployment" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $wl := .workload -}}
{{- $g := $root.Values.global | default dict -}}
{{- $autoscaling := $wl.autoscaling | default dict -}}
{{- $ports := $wl.ports | default dict -}}
{{- $portsEnabled := hasKey $wl "containerPort" -}}
{{- if hasKey $ports "enabled" -}}
{{- $portsEnabled = $ports.enabled -}}
{{- end -}}
{{- $probesEnabled := (and $wl.probes $wl.probes.enabled) -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "common.componentName" (dict "root" $root "component" $component) }}
  labels:
    {{- include "common.componentLabels" (dict "root" $root "component" $component) | nindent 4 }}
  {{- with $g.commonAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if not $autoscaling.enabled }}
  replicas: {{ $wl.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "common.componentSelectorLabels" (dict "root" $root "component" $component) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "common.componentSelectorLabels" (dict "root" $root "component" $component) | nindent 8 }}
      {{- with $wl.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      serviceAccountName: {{ include "common.serviceAccountName" $root }}
      automountServiceAccountToken: {{ $g.serviceAccount.automountServiceAccountToken }}
      {{- with $wl.terminationGracePeriodSeconds }}
      terminationGracePeriodSeconds: {{ . }}
      {{- end }}
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
          {{- if $portsEnabled }}
          ports:
            - name: http
              containerPort: {{ $wl.containerPort }}
              protocol: TCP
          {{- end }}
          env:
            {{- include "common.staticEnv" (dict "workload" $wl) | nindent 12 }}
            {{- include "common.extraEnv" (dict "root" $root "component" $component) | nindent 12 }}
          {{- if $probesEnabled }}
          {{- include "common.probe" (dict "kind" "startup" "probes" $wl.probes) | nindent 10 }}
          {{- include "common.probe" (dict "kind" "liveness" "probes" $wl.probes) | nindent 10 }}
          {{- include "common.probe" (dict "kind" "readiness" "probes" $wl.probes) | nindent 10 }}
          {{- end }}
          {{- with $wl.lifecycle }}
          lifecycle:
            {{- toYaml . | nindent 12 }}
          {{- end }}
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
