import {
  PHASES,
  type EventFeatures,
  type Phase,
  type Phase2Settings,
  type Phase3Settings,
} from '@santa/contracts';

/** Organizer projection as consumed by the console (only fields the server sends). */
export interface OrganizerEventState {
  name: string;
  phase: Phase;
  paused: boolean;
  counts: { participants: number; giftsRegistered: number };
  organizer: {
    roster: { unclaimed: number; pending: number; active: number; removed: number };
    warnings: string[];
    reactionsEnabled?: boolean;
    features?: EventFeatures;
    phase2?: Phase2Settings;
    phase3?: Phase3Settings;
    /** Authoritative server presence for a subscribed display socket. */
    displayConnected: boolean;
  };
}

export interface OrganizerState {
  role: string;
  eventState: OrganizerEventState;
}

export const CONSOLE_TABS = ['live', 'setup', 'people', 'show', 'admin'] as const;
export type ConsoleTab = (typeof CONSOLE_TABS)[number];
export const DEFAULT_TAB: ConsoleTab = 'live';

/** `?tab=` value → known tab (unknown/missing → default). */
export const parseTab = (v: string | null | undefined): ConsoleTab =>
  (CONSOLE_TABS as readonly string[]).includes(v ?? '') ? (v as ConsoleTab) : DEFAULT_TAB;

/** True when `current` is at or past `p` in the phase order. */
export const atOrPast = (current: Phase, p: Phase) => PHASES.indexOf(current) >= PHASES.indexOf(p);

/** Phase the "next" button targets (games is skippable straight to reveal). */
export const nextPhase = (p: Phase): Phase | undefined => PHASES[PHASES.indexOf(p) + 1];
export const prevPhase = (p: Phase): Phase | undefined => PHASES[PHASES.indexOf(p) - 1];

export const tabId = (t: ConsoleTab) => `console-tab-${t}`;
export const panelId = (t: ConsoleTab) => `console-panel-${t}`;
