{{/*
=============================================================================
common.hpa — HorizontalPodAutoscaler for a workload.
=============================================================================
Call with (dict "root" $ "component" "api" "workload" .Values).
Only renders when the workload's autoscaling.enabled is true.
*/}}
{{- define "common.hpa" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $wl := .workload -}}
{{- $autoscaling := $wl.autoscaling | default dict -}}
{{- if $autoscaling.enabled -}}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "common.componentName" (dict "root" $root "component" $component) }}
  labels:
    {{- include "common.componentLabels" (dict "root" $root "component" $component) | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "common.componentName" (dict "root" $root "component" $component) }}
  minReplicas: {{ $autoscaling.minReplicas }}
  maxReplicas: {{ $autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ $autoscaling.targetCPUUtilizationPercentage }}
{{- end -}}
{{- end -}}
