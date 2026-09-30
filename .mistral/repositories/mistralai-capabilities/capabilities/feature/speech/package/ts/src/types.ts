export type SpeechFormat = "pcm" | "wav" | "mp3" | "flac" | "opus";

export type SourceKind = "file_url" | "file_id" | "upload";

export type TranscribeRequest = {
  diarize?: boolean;
  file_content?: string | null;
  file_id?: string | null;
  file_name?: string | null;
  file_url?: string | null;
  language?: string | null;
  model?: string;
  timestamps?: boolean;
};

export type TranscriptionSegment = {
  end: number;
  speaker_id?: string | null;
  start: number;
  text: string;
};

export type TranscribeResult = {
  language?: string | null;
  model: string;
  segments?: Array<TranscriptionSegment>;
  text: string;
};

export type SynthesizeRequest = {
  input: string;
  model?: string;
  ref_audio?: string | null;
  response_format?: SpeechFormat;
  voice_id?: string | null;
};

export type SynthesizeResult = {
  audio_base64: string;
  model: string;
  response_format: SpeechFormat;
};

export type Voice = {
  id: string;
  name: string;
  user_id?: string | null;
  languages?: Array<string>;
  gender?: string | null;
  description?: string | null;
};

export type ListVoicesResult = {
  voices?: Array<Voice>;
  total: number;
};

export type CreateVoiceRequest = {
  sample_audio: string;
  sample_filename?: string | null;
  name?: string | null;
  language?: string | null;
  gender?: string | null;
  description?: string | null;
};

export type RealtimeSessionRequest = {
  model?: string;
};

export type RealtimeSessionToken = {
  token: string;
  expires_at: string;
  ws_url: string;
};

// The external Mistral realtime transcription socket protocol. These frames never cross our own
// HTTP API — the browser exchanges them directly with api.mistral.ai — so they are not part of the
// generated OpenAPI and are hand-declared here beside the mint's request/response.
export type RealtimeAudioFormat = {
  encoding: string;
  sample_rate: number;
};

export type RealtimeClientMessage =
  | {
      type: "session.update";
      session: {
        audio_format: RealtimeAudioFormat;
        target_streaming_delay_ms?: number;
      };
    }
  | { type: "input_audio.append"; audio: string }
  | { type: "input_audio.end" };

export type RealtimeServerMessage =
  | { type: "session.created"; session: { request_id: string } }
  | { type: "session.updated" }
  | { type: "transcription.text.delta"; text: string }
  | { type: "transcription.done"; text: string }
  | { type: "error"; error: { message: string; code: number } };
