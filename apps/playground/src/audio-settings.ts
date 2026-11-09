/**
 * The player's Audio settings, shared by both hosts: the mixer levels, how they are kept on this device, and the one
 * rule for which channel an untagged sound belongs to. No DOM and no three; `audio-panel.ts` is the panel, and
 * `audio-system.ts` holds the gain stages these levels drive.
 */
import { AUDIO_CHANNELS, type AudioChannel } from "@hitreg/core";
import type { SettingsStorage } from "./graphics-settings.js";

export const AUDIO_STORAGE_KEY = "hitreg:audio";

export type AudioLevel = "master" | AudioChannel;
export const AUDIO_LEVELS = ["master", ...AUDIO_CHANNELS] as const satisfies readonly AudioLevel[];

export type AudioSettings = Record<AudioLevel, number> & { muted: boolean };

/** What the gain stages are set to; the master is already 0 when muted. */
export interface AudioMix {
  master: number;
  channels: Record<AudioChannel, number>;
}

export const DEFAULT_AUDIO: Readonly<AudioSettings> = {
  master: 1, music: 1, ambience: 1, effects: 1, interface: 1, voice: 1, muted: false,
};

/** A sound's channel: its tag, else a loop is the world going on around you and anything else is something happening. */
export function channelOf(sound: { channel?: AudioChannel | undefined; loop?: boolean | undefined }): AudioChannel {
  return sound.channel ?? (sound.loop ? "ambience" : "effects");
}

/** The saved settings; defaults when storage is missing, blocked or holds garbage. */
export function loadAudio(storage: SettingsStorage | null | undefined): AudioSettings {
  const settings = { ...DEFAULT_AUDIO };
  try {
    const stored = JSON.parse(storage?.getItem(AUDIO_STORAGE_KEY) ?? "{}") as Partial<AudioSettings> | null;
    for (const level of AUDIO_LEVELS) {
      const value = stored?.[level];
      if (typeof value === "number" && value >= 0 && value <= 1) settings[level] = value;
    }
    if (typeof stored?.muted === "boolean") settings.muted = stored.muted;
  } catch { /* defaults */ }
  return settings;
}

export function saveAudio(storage: SettingsStorage | null | undefined, settings: AudioSettings): void {
  try {
    storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(settings));
  } catch { /* full or blocked storage only loses the setting */ }
}

export function audioMix(settings: AudioSettings): AudioMix {
  const { master, muted, ...channels } = settings;
  return { master: muted ? 0 : master, channels };
}

/** Other players' voices leave through their own context (@hitreg/comms), so they take the master here. */
export function voiceGain(settings: AudioSettings): number {
  const mix = audioMix(settings);
  return mix.master * mix.channels.voice;
}

export interface AudioTargets {
  setMix(mix: AudioMix): void;
  /** Absent until a session has comms, and in a game without them. */
  voice(): { setOutputGain(gain: number): void } | null;
}

export class AudioSettingsController {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly targets: AudioTargets,
    private readonly storage: SettingsStorage | null,
    private current: AudioSettings = loadAudio(storage),
  ) {
    this.apply();
  }

  get settings(): Readonly<AudioSettings> {
    return this.current;
  }

  change(fields: Partial<AudioSettings>): void {
    this.current = { ...this.current, ...fields };
    this.apply();
    saveAudio(this.storage, this.current);
    for (const listener of this.listeners) listener();
  }

  /** Called on any change, for the panel. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private apply(): void {
    this.targets.setMix(audioMix(this.current));
    this.targets.voice()?.setOutputGain(voiceGain(this.current));
  }
}
