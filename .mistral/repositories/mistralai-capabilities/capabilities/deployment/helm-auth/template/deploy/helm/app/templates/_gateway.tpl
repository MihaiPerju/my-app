{{/*
Gateway OIDC issuer/clientId with single-source-of-truth fallback to ingress.oidc.*
so auth.oidc.* and the existing ingress.oidc.* never diverge.
*/}}
{{- define "gateway.oidc.issuerUrl" -}}
{{- $auth := .Values.auth | default dict -}}
{{- $oidc := $auth.oidc | default dict -}}
{{- $ingressOidc := .Values.ingress.oidc | default dict -}}
{{- required "auth.oidc.issuerUrl or ingress.oidc.issuerUrl is required in oidc mode" (default $ingressOidc.issuerUrl $oidc.issuerUrl) -}}
{{- end -}}

{{- define "gateway.oidc.clientId" -}}
{{- $auth := .Values.auth | default dict -}}
{{- $oidc := $auth.oidc | default dict -}}
{{- $ingressOidc := .Values.ingress.oidc | default dict -}}
{{- required "auth.oidc.clientId or ingress.oidc.clientId is required in oidc mode" (default $ingressOidc.clientId $oidc.clientId) -}}
{{- end -}}
