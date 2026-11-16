import type { FxEngine } from './engine';

let engine: FxEngine | undefined;

export const setFxEngine = (e: FxEngine | undefined) => {
  engine = e;
};

/** Domain event -> cue. Safe to call anywhere (no-op until the overlay mounts). */
export const emitFx: FxEngine['emit'] = (event) => engine?.emit(event);
export const setAmbient: FxEngine['setAmbient'] = (on) => engine?.setAmbient(on);
