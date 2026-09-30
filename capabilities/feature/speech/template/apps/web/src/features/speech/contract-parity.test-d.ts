import type {
  CreateVoiceRequest,
  ListVoicesResult,
  RealtimeSessionRequest,
  RealtimeSessionToken,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  Voice,
} from "@mistralai-capabilities/feature-speech";

import type {
  CreateVoiceRequest as GeneratedCreateVoiceRequest,
  ListVoicesResult as GeneratedListVoicesResult,
  RealtimeSessionRequest as GeneratedRealtimeSessionRequest,
  RealtimeSessionToken as GeneratedRealtimeSessionToken,
  SynthesizeRequest as GeneratedSynthesizeRequest,
  SynthesizeResult as GeneratedSynthesizeResult,
  TranscribeRequest as GeneratedTranscribeRequest,
  TranscribeResult as GeneratedTranscribeResult,
  Voice as GeneratedVoice,
} from "@/api/generated/types.gen";

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const transcribeRequestParity: MutuallyAssignable<
  TranscribeRequest,
  GeneratedTranscribeRequest
> = true;
export const transcribeResultParity: MutuallyAssignable<
  TranscribeResult,
  GeneratedTranscribeResult
> = true;
export const synthesizeRequestParity: MutuallyAssignable<
  SynthesizeRequest,
  GeneratedSynthesizeRequest
> = true;
export const synthesizeResultParity: MutuallyAssignable<
  SynthesizeResult,
  GeneratedSynthesizeResult
> = true;
export const voiceParity: MutuallyAssignable<Voice, GeneratedVoice> = true;
export const listVoicesResultParity: MutuallyAssignable<
  ListVoicesResult,
  GeneratedListVoicesResult
> = true;
export const createVoiceRequestParity: MutuallyAssignable<
  CreateVoiceRequest,
  GeneratedCreateVoiceRequest
> = true;
export const realtimeSessionRequestParity: MutuallyAssignable<
  RealtimeSessionRequest,
  GeneratedRealtimeSessionRequest
> = true;
export const realtimeSessionTokenParity: MutuallyAssignable<
  RealtimeSessionToken,
  GeneratedRealtimeSessionToken
> = true;
