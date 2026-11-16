import type { FxEngine } from './engine';

let engine: FxEngine | undefined;

export const setFxEngine = (e: FxEngine | undefined) => {
  engine = e;
};

/** Domain event -> cue. Safe to call anywhere (no-op until the overlay mounts). */
export const emitFx: FxEngine['emit'] = (event, opts) => engine?.emit(event, opts);
export const setAmbient: FxEngine['setAmbient'] = (on) => engine?.setAmbient(on);
