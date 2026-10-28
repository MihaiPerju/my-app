import { AutosizeTextarea } from "@mistralai/ui/autosize-textarea";
import { Button } from "@mistralai/ui/button";
import { ArrowUpIcon, CheckIcon, MicrophoneIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";

import { useVoiceInput, type UseVoiceInputResult, type VoiceInputStatus } from "../use-voice-input";
import { ChatPlusMenu } from "./chat-plus-menu";

type ChatComposerProps = {
  onSend: (message: string) => void;
  onStop?: () => void;
  isResponding?: boolean;
  disabled?: boolean;
};

/**
 * Owns the draft text.
 *
 * It is not lifted to `ChatPage`, because the thread parses every answer through `parseMarkdown`, so
 * a draft held above would re-parse all answers on every keystroke. `onSend` carries it up.
 */
export function ChatComposer({
  onSend,
  onStop,
  isResponding = false,
  disabled = false,
}: ChatComposerProps) {
  const [input, setInput] = useState("");
  const voice = useVoiceInput({ text: input, onTextChange: setInput });
  const isDictating = voice.status !== "idle";
  const { cancel } = voice;

  /**
   * Discard is a key, not a button.
   *
   * The tray holds one control, Stop, which keeps the utterance. Escape is the discard affordance.
   * It is a global listener, not the textarea's `onKeyDown`, because focus can be anywhere, and it
   * must keep working through transcribing, where Stop is disabled and it is the only live control.
   */
  useEffect(() => {
    if (!isDictating) return undefined;
    const discardOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", discardOnEscape);
    return () => window.removeEventListener("keydown", discardOnEscape);
  }, [cancel, isDictating]);

  const hasContent = input.trim().length > 0;
  // Dictation fills the textarea as it goes, so `hasContent` turns true mid-utterance.
  // Sending on that would cut the user off part-way through their own sentence.
  const canSend = hasContent && !disabled && !isDictating;
  const canStop = isResponding && Boolean(onStop);

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend(input);
    setInput("");
  }, [canSend, input, onSend]);

  const handleReset = useCallback(() => setInput(""), []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="bg-card flex flex-col gap-3 rounded-[calc(var(--radius-xl)-1.5px)] p-3 shadow-sm dark:shadow-none"
    >
      <div className="flex items-center gap-2">
        <ChatPlusMenu onReset={handleReset} disabled={disabled} />

        <AutosizeTextarea
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type / for quick access"
          // Not redundant with minRows, and deleting it brings the shift back: the
          // library's SSR build discards minRows/maxRows, so the server would emit a
          // bare <textarea> and the browser would paint the HTML default of two rows
          // until hydration collapsed it to one. `rows` is passed through by both
          // builds, so SSR matches the client and the post-hydration inline height wins.
          rows={1}
          minRows={1}
          maxRows={8}
          disabled={disabled}
          className="caret-brand-500 text-default placeholder:text-placeholder min-w-0 grow resize-none break-words border-0 bg-transparent px-0.5 py-1 text-base leading-6 shadow-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60 sm:text-base"
          aria-label="Chat message"
        />

        <TrailingControls
          canStop={canStop}
          onStop={onStop}
          hasContent={hasContent}
          disabled={disabled}
          voice={voice}
          isDictating={isDictating}
        />
      </div>

      {voice.error ? (
        <p role="alert" className="text-basic-red-strong px-0.5 text-xs">
          {voice.error}
        </p>
      ) : null}
    </form>
  );
}

type TrailingControlsProps = {
  canStop: boolean;
  onStop?: () => void;
  hasContent: boolean;
  disabled: boolean;
  voice: UseVoiceInputResult;
  isDictating: boolean;
};

function TrailingControls({
  canStop,
  onStop,
  hasContent,
  disabled,
  voice,
  isDictating,
}: TrailingControlsProps): ReactElement | null {
  if (canStop) {
    return <StopButton onStop={onStop} />;
  }
  if (isDictating) {
    return <DictationControls status={voice.status} onStop={voice.stop} />;
  }
  if (hasContent) {
    return <SendButton />;
  }
  // No capability provides dictation: there is no mic to offer, and Send appears once there is text.
  if (!voice.isAvailable) {
    return null;
  }
  return <MicButton onStart={voice.start} disabled={disabled || !voice.isSupported} />;
}

function SendButton(): ReactElement {
  return (
    <Button
      type="submit"
      size="sm"
      variant="primary"
      mode="icon-only"
      icon={<ArrowUpIcon className="size-4" />}
      aria-label="Send message"
      className="shrink-0"
    />
  );
}

function MicButton({
  onStart,
  disabled,
}: {
  onStart: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <Button
      type="button"
      size="sm"
      variant="primary"
      mode="icon-only"
      onClick={onStart}
      isDisabled={disabled}
      icon={<MicrophoneIcon className="size-4" />}
      aria-label="Start voice input"
      className="shrink-0"
    />
  );
}

function DictationControls({
  status,
  onStop,
}: {
  status: VoiceInputStatus;
  onStop: () => void;
}): ReactElement {
  const isTranscribing = status === "transcribing";
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-hint hidden text-xs whitespace-nowrap sm:block">Esc to discard</span>
      <Button
        type="button"
        size="sm"
        variant="primary"
        mode="icon-only"
        onClick={onStop}
        isDisabled={isTranscribing}
        isLoading={isTranscribing}
        icon={isTranscribing ? <CheckIcon className="size-4" /> : <StopIcon className="size-4" />}
        aria-label={isTranscribing ? "Transcribing" : "Stop voice input"}
        className="shrink-0"
      />
    </div>
  );
}

function StopButton({ onStop }: { onStop?: () => void }): ReactElement {
  return (
    <Button
      type="button"
      size="sm"
      variant="primary"
      mode="icon-only"
      onClick={onStop}
      icon={<StopIcon className="size-4" />}
      aria-label="Stop generating"
      className="shrink-0"
    />
  );
}
