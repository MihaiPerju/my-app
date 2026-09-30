{{/*
=============================================================================
common.service — generic ClusterIP Service (api/web; agent if enabled).
=============================================================================
Call with (dict "root" $ "component" "api" "workload" .Values).
*/}}
{{- define "common.service" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $wl := .workload -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "common.componentName" (dict "root" $root "component" $component) }}
  labels:
    {{- include "common.componentLabels" (dict "root" $root "component" $component) | nindent 4 }}
spec:
  type: {{ $wl.service.type }}
  selector:
    {{- include "common.componentSelectorLabels" (dict "root" $root "component" $component) | nindent 4 }}
  ports:
    - name: http
      port: {{ $wl.service.port }}
      targetPort: http
      protocol: TCP
{{- end -}}
