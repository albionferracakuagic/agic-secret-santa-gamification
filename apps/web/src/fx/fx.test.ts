import { describe, expect, it, vi } from 'vitest';
import { EVENT_TO_CUE, FX_CATALOG, FX_EVENTS, SFX_IDS } from './catalog';
import { createFxEngine, type FxHost } from './engine';
import { FrameMonitor } from './perf';
import { MUSIC_DEF, SFX_DEFS, synthWav } from './audio';
import manifest from './assets.manifest.json';
import { en } from '../i18n/en';

const NEGATIVE =
  /fail|wrong|lose|loser|last|worst|sad|boo|miss|error|penalt|shame|dislike|angry|cry/i;

describe('FX catalog (FR-036, FR-046.4)', () => {
  it('maps every FR-036 event to a cue and has no negative cues or texts', () => {
    expect(Object.keys(EVENT_TO_CUE).sort()).toEqual([...FX_EVENTS].sort());
    for (const [id, cue] of Object.entries(FX_CATALOG)) {
      expect(cue.id).toBe(id);
      expect(id).not.toMatch(NEGATIVE);
      expect((en.fx as Record<string, string>)[id]).toBeTruthy();
      expect((en.fx as Record<string, string>)[id]).not.toMatch(NEGATIVE);
      if ('sfx' in cue) expect(SFX_IDS).toContain(cue.sfx);
    }
  });
});

function fakeHost() {
  const h = {
    emoji: vi.fn(),
    confetti: vi.fn(),
    fireworks: vi.fn(),
    snow: vi.fn(),
    lights: vi.fn(),
    announce: vi.fn(),
    play: vi.fn(),
  } satisfies FxHost;
  return h;
}
const mk = (over: Partial<Parameters<typeof createFxEngine>[0]> = {}) => {
  const host = fakeHost();
  let t = 0;
  const engine = createFxEngine({
    host,
    getPrefs: () => ({ sound: false, intensity: 'normal', reducedMotion: 'off' }),
    getCap: () => 'high',
    translate: (k) => `T:${k}`,
    systemReduce: () => false,
    now: () => (t += 1000),
    ...over,
  });
  return { host, engine };
};

describe('FX engine', () => {
  it('always announces text; visuals follow intensity', () => {
    const { host, engine } = mk();
    engine.emit('grand_winner');
    expect(host.announce).toHaveBeenCalledWith('T:fx.trophy_fireworks');
    expect(host.fireworks).toHaveBeenCalledWith(5);
  });

  it('reduced motion / off: text equivalent only, no visuals, no sound', () => {
    const { host, engine } = mk({
      getPrefs: () => ({ sound: true, intensity: 'high', reducedMotion: 'on' }),
    });
    engine.emit('correct_guess');
    engine.emit('vote_submitted');
    expect(host.announce).toHaveBeenCalledTimes(2);
    for (const fn of [host.emoji, host.confetti, host.fireworks, host.play])
      expect(fn).not.toHaveBeenCalled();
    engine.setAmbient(true);
    expect(host.snow).toHaveBeenCalledWith(false, 0);
  });

  it('sound is opt-in; intensity scales counts; auto-degrade cap lowers them', () => {
    const on = mk({ getPrefs: () => ({ sound: true, intensity: 'normal', reducedMotion: 'off' }) });
    on.engine.emit('vote_submitted');
    expect(on.host.play).toHaveBeenCalledWith('chime');
    const off = mk();
    off.engine.emit('vote_submitted');
    expect(off.host.play).not.toHaveBeenCalled();

    const high = mk({
      getPrefs: () => ({ sound: false, intensity: 'high', reducedMotion: 'off' }),
    });
    high.engine.emit('correct_guess');
    expect(high.host.confetti).toHaveBeenCalledWith(144);
    const capped = mk({
      getPrefs: () => ({ sound: false, intensity: 'high', reducedMotion: 'off' }),
      getCap: () => 'low',
    });
    capped.engine.emit('correct_guess');
    expect(capped.host.confetti).toHaveBeenCalledWith(36);
  });

  it('throttles repeated identical cues (reaction spam)', () => {
    const host = fakeHost();
    const engine = createFxEngine({
      host,
      getPrefs: () => ({ sound: false, intensity: 'normal', reducedMotion: 'off' }),
      getCap: () => 'high',
      translate: (k) => k,
      systemReduce: () => false,
      now: () => 100,
    });
    for (let i = 0; i < 10; i++) engine.emit('reaction_received');
    expect(host.emoji).toHaveBeenCalledTimes(1);
  });
});

describe('perf auto-degrade', () => {
  it('flags sustained slow frames but not a single hiccup', () => {
    const fast = new FrameMonitor();
    let t = 0;
    let flagged = false;
    for (let i = 0; i < 120; i++) flagged ||= fast.push(16, (t += 16));
    expect(flagged).toBe(false);

    const hiccup = new FrameMonitor();
    t = 0;
    flagged = false;
    for (let i = 0; i < 60; i++)
      flagged ||= hiccup.push(i === 30 ? 200 : 16, (t += i === 30 ? 200 : 16));
    expect(flagged).toBe(false);

    const slow = new FrameMonitor();
    t = 0;
    flagged = false;
    for (let i = 0; i < 60; i++) flagged ||= slow.push(50, (t += 50));
    expect(flagged).toBe(true);
  });
});

describe('procedural audio + asset manifest', () => {
  it('synthesizes valid WAV data for every SFX and the music loop', () => {
    for (const d of [...Object.values(SFX_DEFS), MUSIC_DEF]) {
      const wav = synthWav(d.tones, d.totalMs);
      const v = new DataView(wav.buffer);
      expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
      expect(v.getUint32(40, true)).toBe(wav.length - 44);
      expect(wav.subarray(44).some((b) => b !== 0)).toBe(true);
    }
  });

  it('every asset declares a source and an allowed license (no copyrighted media)', () => {
    const allowed = /^(CC0-1\.0|ISC|MIT|n\/a \(system font\))$/;
    expect(manifest.assets.length).toBeGreaterThan(0);
    for (const a of manifest.assets) {
      expect(a.source).toBeTruthy();
      expect(a.license).toMatch(allowed);
    }
  });
});
