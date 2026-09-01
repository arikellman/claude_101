/**
 * Web Speech API wrapper for voice logging (plan 5.5). Thin on purpose: this only does
 * speech-to-text. Turning the transcript into structured nutrition data is still
 * Claude's job via the existing 'voice' estimation mode - this just replaces typing
 * with talking as the way text gets into that pipeline.
 *
 * Chrome on Android supports `webkitSpeechRecognition`; the unprefixed `SpeechRecognition`
 * covers desktop Chrome. Safari/Firefox support is inconsistent, so the UI must keep the
 * typed-text textarea as a first-class fallback, not degrade silently to a dead mic button.
 */

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

// Minimal structural type for what this file actually uses - the full lib.dom types for
// the Web Speech API are not part of TypeScript's standard DOM lib.
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

export function voiceRecognitionSupported(): boolean {
  return getCtor() !== null;
}

export interface VoiceSession {
  stop: () => void;
}

/**
 * Start listening. `onUpdate` fires with the running transcript on every result event
 * (interim and final) so the UI can show live text; `onDone` fires once when recognition
 * ends, whether by silence timeout, an explicit `stop()`, or an error.
 */
export function startVoiceRecognition(
  onUpdate: (transcript: string) => void,
  onDone: (finalTranscript: string) => void,
  onError: (message: string) => void
): VoiceSession | null {
  const Ctor = getCtor();
  if (!Ctor) {
    onError("Voice input isn't supported in this browser - type it instead.");
    return null;
  }

  const recognition = new Ctor();
  recognition.lang = "en-US"; // Hebrew items are handled fine as English speech + code-switched nouns
  recognition.interimResults = true;
  recognition.continuous = true;

  let finalText = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i] as unknown as { isFinal?: boolean; 0: { transcript: string } };
      if (result.isFinal) finalText += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    onUpdate((finalText + interim).trim());
  };

  recognition.onerror = (event) => {
    // "no-speech" fires routinely when the user pauses - not worth surfacing as an error.
    if (event.error !== "no-speech") onError(`Voice recognition error: ${event.error}`);
  };

  recognition.onend = () => onDone(finalText.trim());

  recognition.start();
  return { stop: () => recognition.stop() };
}
