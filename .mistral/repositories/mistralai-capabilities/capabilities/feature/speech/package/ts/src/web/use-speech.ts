import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SpeechApi } from "../api";
import type { CreateVoiceRequest, SynthesizeRequest, TranscribeRequest } from "../types";

const VOICES_QUERY_KEY = ["speech", "voices"] as const;

export function useTranscribeMutation(api: SpeechApi) {
  return useMutation({
    mutationFn: (body: TranscribeRequest) => api.transcribe(body),
  });
}

export function useSynthesizeMutation(api: SpeechApi) {
  return useMutation({
    mutationFn: (body: SynthesizeRequest) => api.synthesize(body),
  });
}

export function useVoicesQuery(api: SpeechApi) {
  return useQuery({
    queryKey: VOICES_QUERY_KEY,
    queryFn: () => api.listVoices(),
  });
}

export function useCreateVoiceMutation(api: SpeechApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateVoiceRequest) => api.createVoice(body),
    // A fresh clone must show up in the picker immediately; refetch the list on success.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: VOICES_QUERY_KEY }),
  });
}
