import type { Howl } from 'howler';
import type { SfxId } from './catalog';

export interface Tone {
  freq: number;
  startMs: number;
  durMs: number;
  gain: number;
}

const RATE = 22050;

/** Procedural 16-bit mono PCM WAV: original synthesized tones (CC0), no sampled/copyrighted media. */
export function synthWav(tones: readonly Tone[], totalMs: number, rate = RATE): Uint8Array {
  const n = Math.floor((totalMs / 1000) * rate);
  const pcm = new Int16Array(n);
  for (const t of tones) {
    const start = Math.floor((t.startMs / 1000) * rate);
    const len = Math.floor((t.durMs / 1000) * rate);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp((-4 * i) / len) * Math.min(1, i / 120); // click-free attack, exponential decay
      pcm[start + i]! += Math.round(
        Math.sin((2 * Math.PI * t.freq * i) / rate) * t.gain * env * 12000,
      );
    }
  }
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++)
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, pcm[i]!)), true);
  return out;
}

export const SFX_DEFS: Record<SfxId, { totalMs: number; tones: Tone[] }> = {
  bell: {
    totalMs: 900,
    tones: [
      { freq: 880, startMs: 0, durMs: 900, gain: 0.6 },
      { freq: 1320, startMs: 0, durMs: 700, gain: 0.35 },
    ],
  },
  chime: {
    totalMs: 600,
    tones: [
      { freq: 1046, startMs: 0, durMs: 350, gain: 0.5 },
      { freq: 1568, startMs: 120, durMs: 480, gain: 0.45 },
    ],
  },
  whoosh: {
    totalMs: 400,
    tones: [
      { freq: 300, startMs: 0, durMs: 400, gain: 0.3 },
      { freq: 450, startMs: 60, durMs: 300, gain: 0.2 },
    ],
  },
  sparkle: {
    totalMs: 700,
    tones: [1319, 1760, 2093, 2637].map((freq, i) => ({
      freq,
      startMs: i * 90,
      durMs: 300,
      gain: 0.35,
    })),
  },
};

/** Gentle original pentatonic arpeggio loop (not a known melody). */
export const MUSIC_DEF = {
  totalMs: 8000,
  tones: [262, 330, 392, 523, 392, 330, 294, 392].flatMap((freq, i) => [
    { freq, startMs: i * 1000, durMs: 900, gain: 0.5 },
    { freq: freq / 2, startMs: i * 1000, durMs: 900, gain: 0.25 },
  ]),
} as const;

const toDataUri = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(s)}`;
};

type HowlCtor = typeof Howl;
let HowlClass: HowlCtor | undefined;
let unlocked = false;
const cache = new Map<string, InstanceType<HowlCtor>>();
let music: InstanceType<HowlCtor> | undefined;

async function howl() {
  const mod = await import('howler');
  HowlClass = mod.Howl;
  return mod;
}

/** Call from a user gesture (e.g. enabling sound): browsers block audio until then. */
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  void howl().then((m) => m.Howler.ctx?.resume());
}
export const isAudioUnlocked = () => unlocked;

export async function playSfx(id: SfxId) {
  if (!unlocked) return;
  await howl();
  let h = cache.get(id);
  if (!h) {
    const d = SFX_DEFS[id];
    h = new HowlClass!({ src: [toDataUri(synthWav(d.tones, d.totalMs))], volume: 0.5 });
    cache.set(id, h);
  }
  h.play();
}

export async function setMusic(on: boolean) {
  if (!on) return void music?.stop();
  if (!unlocked) return;
  await howl();
  music ??= new HowlClass!({
    src: [toDataUri(synthWav(MUSIC_DEF.tones, MUSIC_DEF.totalMs))],
    loop: true,
    volume: 0.15,
  });
  if (!music.playing()) music.play();
}
