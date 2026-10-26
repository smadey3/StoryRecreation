"use client";

import { useState } from "react";
import { renderChime } from "@/lib/shared/chime";
import type { ChimeStyle } from "@/lib/shared/types";

let ctx: AudioContext | null = null;

/** Play the same page-turn chime that gets baked into the story audio. */
export function previewChime(style: ChimeStyle) {
  ctx ??= new AudioContext();
  void ctx.resume();
  const samples = renderChime(style, ctx.sampleRate, 0.5);
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
}

let voiceAudio: HTMLAudioElement | null = null;

/** Play a voice sample; calling again stops the previous one. `on` hears when it starts playing, or that it can't. */
export function previewVoice(url: string | null | undefined, on: { playing?: () => void; failed?: () => void } = {}): boolean {
  voiceAudio?.pause();
  if (!url) return false;
  const audio = new Audio(url);
  voiceAudio = audio;
  audio.addEventListener("playing", () => on.playing?.(), { once: true });
  audio.addEventListener("error", () => on.failed?.(), { once: true });
  void audio.play().catch((err: unknown) => {
    if (!(err instanceof DOMException && err.name === "AbortError")) on.failed?.();
  });
  return true;
}

/**
 * "Hear me" buttons that say when a voice is getting ready to be heard (a family voice reading its sample for the
 * first time takes a few seconds), and when it couldn't be.
 */
export function useVoicePreview() {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const done = (id: string) => setWaiting((w) => (w === id ? null : w));
  const hear = (id: string, url: string | null | undefined): boolean => {
    setFailed(null);
    setWaiting(id);
    const playing = previewVoice(url, {
      playing: () => done(id),
      failed: () => {
        done(id);
        setFailed(id);
      },
    });
    if (!playing) done(id);
    return playing;
  };
  const label = (id: string, idle = "▶ Hear me") => (waiting === id ? "⏳ A moment…" : failed === id ? "▶ Try again" : idle);
  return { hear, label };
}

export function stopPreview() {
  voiceAudio?.pause();
}
