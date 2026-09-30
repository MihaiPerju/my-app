import type {
  CreateVoiceRequest,
  SpeechFormat,
  SynthesizeRequest,
  TranscribeRequest,
  Voice,
} from "./types";

export type TranscribeFormState = {
  sourceKind: "file_url" | "file_id" | "upload";
  source: string;
  fileName: string;
  fileContent: string;
  language: string;
  diarize: boolean;
  timestamps: boolean;
};

export const INITIAL_TRANSCRIBE_FORM: TranscribeFormState = {
  sourceKind: "file_url",
  source: "",
  fileName: "",
  fileContent: "",
  language: "",
  diarize: false,
  timestamps: false,
};

export type SynthesizeFormState = {
  input: string;
  voiceId: string;
  refAudio: string;
  responseFormat: SpeechFormat;
};

export const INITIAL_SYNTHESIZE_FORM: SynthesizeFormState = {
  input: "",
  voiceId: "",
  refAudio: "",
  responseFormat: "mp3",
};

export const MIME_BY_FORMAT: Record<SpeechFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  opus: "audio/ogg",
  pcm: "audio/L16",
};

export function buildTranscribeRequest(form: TranscribeFormState): TranscribeRequest {
  const language = form.language.trim() || undefined;
  const common = { language, diarize: form.diarize, timestamps: form.timestamps };
  if (form.sourceKind === "upload") {
    return { ...common, file_content: form.fileContent, file_name: form.fileName || undefined };
  }
  const source = form.source.trim();
  return form.sourceKind === "file_url"
    ? { ...common, file_url: source }
    : { ...common, file_id: source };
}

export function buildSynthesizeRequest(form: SynthesizeFormState): SynthesizeRequest {
  return {
    input: form.input,
    voice_id: form.voiceId.trim() || undefined,
    ref_audio: form.refAudio.trim() || undefined,
    response_format: form.responseFormat,
  };
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Could not read file")),
      {
        once: true,
      },
    );
    reader.addEventListener(
      "load",
      () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("Could not read file"));
          return;
        }
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

export type CloneVoiceFormState = {
  name: string;
  language: string;
  gender: string;
  description: string;
  sampleFileName: string;
  sampleAudio: string;
};

export const INITIAL_CLONE_VOICE_FORM: CloneVoiceFormState = {
  name: "",
  language: "",
  gender: "",
  description: "",
  sampleFileName: "",
  sampleAudio: "",
};

/**
 * Whether a voice is the caller's own saved clone rather than a built-in preset.
 *
 * `user_id` is the API's ownership marker — null for a preset. The picker keys its clone control
 * off this so it never offers to clone over a voice the API would refuse to mutate.
 */
export function isOwnedVoice(voice: Voice): boolean {
  return voice.user_id != null;
}

/** The picker label for a voice: its name plus a preset/custom tag and its first language, if any. */
export function voiceOptionLabel(voice: Voice): string {
  const kind = isOwnedVoice(voice) ? "custom" : "preset";
  const language = voice.languages?.[0];
  return language ? `${voice.name} · ${kind} · ${language}` : `${voice.name} · ${kind}`;
}

export function buildCreateVoiceRequest(form: CloneVoiceFormState): CreateVoiceRequest {
  return {
    sample_audio: form.sampleAudio,
    sample_filename: form.sampleFileName || undefined,
    name: form.name.trim() || undefined,
    language: form.language.trim() || undefined,
    gender: form.gender.trim() || undefined,
    description: form.description.trim() || undefined,
  };
}
