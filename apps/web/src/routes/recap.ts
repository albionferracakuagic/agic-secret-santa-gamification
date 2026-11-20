import type { Phase } from '@santa/contracts';

/** Participant post-event recap. Organizer/display links (later) should import this, not hard-code the path. */
export const RECAP_PATH = '/e/recap';

/** The recap only makes sense once the show reached the awards. */
export const RECAP_PHASES: readonly Phase[] = ['awards', 'completed'];

export const isRecapPhase = (phase: Phase | undefined): boolean =>
  !!phase && RECAP_PHASES.includes(phase);
