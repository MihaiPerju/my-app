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
} from "./types";

export interface SpeechApi {
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResult>;
  realtimeSession(request: RealtimeSessionRequest): Promise<RealtimeSessionToken>;
  listVoices(): Promise<ListVoicesResult>;
  createVoice(request: CreateVoiceRequest): Promise<Voice>;
}
