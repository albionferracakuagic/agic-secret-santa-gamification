import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AUTOPILOT_PRESET_KEYS,
  AutopilotSettingsSchema,
  DEFAULT_EVENT_FEATURES,
  Phase2SettingsSchema,
  Phase3SettingsSchema,
  type AutopilotSettings,
  type AutopilotTimings,
  type EventFeatures,
  type Phase,
} from '@santa/contracts';
import type { AccessLink } from '../../../api/organizer';
import { errorKey } from '../../../pages/Dashboard';
import { AccessPanel } from '../AccessPanel';
import { PairingWizard } from '../PairingWizard';
import { ApprovalPanel, ReactionSettings } from '../Approvals';
import { BoardsConsole, CeremonyControls } from '../ShowControls';
import { UnmaskForm } from '../Unmask';
import {
  AuditViewer,
  GiftModerationPanel,
  IntegrityPanel,
  RemoveParticipants,
  StatsCard,
} from '../AdminPanels';
import { ClueQueue, GamesConsole, MissionsConsole, PresentationControls } from '../Phase2Controls';
import {
  ArchiveConsole,
  AuctionConsole,
  CoinsConsole,
  EditorConsole,
  FeaturesPanel,
} from '../Phase3Controls';
import { OpeningControls, RevealControls, VotingControls } from '../GameControls';
import { atOrPast, type OrganizerEventState } from './types';
import { autopilotOf } from './LiveTab';
import { useAutopilot } from './useAutopilot';

interface TabProps {
  eventId: string;
  state: OrganizerEventState;
}

export const featuresOf = (s: OrganizerEventState): EventFeatures => ({
  ...DEFAULT_EVENT_FEATURES,
  ...s.organizer.features,
});

/** Setup: features/settings, pairing, reactions, categories & custom achievements. */
export function SetupTab({ eventId, state: s }: TabProps) {
  return (
    <>
      <AutopilotSettingsForm eventId={eventId} state={s} />
      <FeaturesPanel
        eventId={eventId}
        phase={s.phase}
        features={featuresOf(s)}
        phase2={s.organizer.phase2 ?? Phase2SettingsSchema.parse({})}
        phase3={s.organizer.phase3 ?? Phase3SettingsSchema.parse({})}
      />
      <PairingWizard eventId={eventId} />
      <ReactionSettings eventId={eventId} initial={s.organizer.reactionsEnabled} />
      <EditorConsole eventId={eventId} />
    </>
  );
}

type TimingKey = keyof AutopilotTimings;
type AutopilotDraft = {
  preset: AutopilotSettings['preset'];
  includeExtras: boolean;
} & Record<TimingKey, number | null>;

const TIMING_KEYS = [
  'openingGiftSeconds',
  'votingMinutes',
  'gamesMinutes',
  'revealGiftSeconds',
  'interludeSeconds',
] as const satisfies readonly TimingKey[];
const DEFAULT_AUTOPILOT_SETTINGS = AutopilotSettingsSchema.parse({});

const makeDraft = (settings: AutopilotSettings): AutopilotDraft => ({
  preset: settings.preset,
  includeExtras: settings.includeExtras,
  openingGiftSeconds: settings.openingGiftSeconds ?? null,
  votingMinutes: settings.votingMinutes ?? null,
  gamesMinutes: settings.gamesMinutes ?? null,
  revealGiftSeconds: settings.revealGiftSeconds ?? null,
  interludeSeconds: settings.interludeSeconds ?? null,
});

/** Compact preset/override form; privacy and feature floors stay server-controlled. */
export function AutopilotSettingsForm({
  eventId,
  state,
}: {
  eventId: string;
  state: OrganizerEventState;
}) {
  const { t } = useTranslation();
  const autopilot = useAutopilot(eventId, autopilotOf(state));
  const settings = autopilot.response?.settings ?? DEFAULT_AUTOPILOT_SETTINGS;
  const [draft, setDraft] = useState<AutopilotDraft>(() => makeDraft(settings));
  const timings = autopilot.response?.timings;

  useEffect(() => {
    setDraft(makeDraft(settings));
  }, [settings]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    autopilot.patch.mutate(draft);
  };
  const completed = state.phase === 'completed';
  const disabled = completed || autopilot.patch.isPending || autopilot.query.isLoading;
  const input =
    'mt-1 block min-h-11 w-full rounded border border-ink-900/50 bg-white px-3 disabled:opacity-50';

  return (
    <form
      onSubmit={submit}
      aria-labelledby="autopilot-settings-title"
      className="space-y-3 rounded border border-pine-900/30 bg-white p-4"
      data-testid="autopilot-settings"
    >
      <div>
        <h2 id="autopilot-settings-title" className="text-xl font-semibold">
          {t('autopilot.settings.title')}
        </h2>
        <p className="text-sm">{t('autopilot.settings.hint')}</p>
      </div>
      <label className="block">
        {t('autopilot.settings.preset')}
        <select
          className={input}
          value={draft.preset}
          disabled={disabled}
          onChange={(e) =>
            setDraft((current) => ({
              ...current,
              preset: e.target.value as AutopilotSettings['preset'],
            }))
          }
        >
          {AUTOPILOT_PRESET_KEYS.map((preset) => (
            <option key={preset} value={preset}>
              {t(`autopilot.settings.presetName.${preset}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={draft.includeExtras}
          disabled={disabled}
          onChange={(e) =>
            setDraft((current) => ({ ...current, includeExtras: e.target.checked }))
          }
        />
        <span>{t('autopilot.settings.includeExtras')}</span>
      </label>
      <fieldset className="space-y-2">
        <legend className="font-semibold">{t('autopilot.settings.overrides')}</legend>
        <p className="text-sm">{t('autopilot.settings.overrideHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {TIMING_KEYS.map((key) => (
            <label key={key} className="block">
              {t(`autopilot.settings.timing.${key}`)}
              <input
                type="number"
                min={key === 'interludeSeconds' ? 0 : 1}
                max={timingMax(key)}
                step={1}
                className={input}
                value={draft[key] ?? ''}
                placeholder={timings ? String(timings[key]) : undefined}
                disabled={disabled}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    [key]: e.target.value === '' ? null : Number(e.target.value),
                  }))
                }
              />
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="submit"
        className="min-h-12 w-full rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50"
        disabled={disabled}
      >
        {t('autopilot.settings.save')}
      </button>
      {completed && <p className="text-sm">{t('autopilot.settings.locked')}</p>}
      {autopilot.patch.isSuccess && (
        <p role="status">{t('autopilot.settings.saved')}</p>
      )}
      {(autopilot.query.isError || autopilot.patch.isError) && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(autopilot.patch.error ?? autopilot.query.error))}
        </p>
      )}
    </form>
  );
}

const timingMax = (key: TimingKey) => {
  if (key === 'openingGiftSeconds') return 600;
  if (key === 'revealGiftSeconds') return 300;
  if (key === 'interludeSeconds') return 120;
  return 120;
};

/** People: invitations/QR/codes, approvals, roster counts, removal. */
export function PeopleTab({
  eventId,
  state: s,
  onAccessLink,
}: TabProps & { onAccessLink?: ((l: AccessLink) => void) | undefined }) {
  const { t } = useTranslation();
  const r = s.organizer.roster;
  return (
    <>
      <AccessPanel eventId={eventId} onLink={onAccessLink} />
      <section aria-labelledby="roster-title" className="space-y-1">
        <h2 id="roster-title" className="text-xl font-semibold">
          {t('console.roster')}
        </h2>
        <p>
          {t('console.rosterCounts', {
            active: r.active,
            pending: r.pending,
            unclaimed: r.unclaimed,
          })}
        </p>
      </section>
      <ApprovalPanel eventId={eventId} />
      <RemoveParticipants eventId={eventId} />
    </>
  );
}

interface ShowPanel {
  key: string;
  /** Phases where this panel is the primary thing to run (sorted first). */
  primary: Phase[];
  node: ReactNode;
}

/** Ordered show panels visible for this state; current-phase panels first, otherwise original order. */
export function showPanels(eventId: string, s: OrganizerEventState): ShowPanel[] {
  const f = featuresOf(s);
  const at = (p: Phase) => atOrPast(s.phase, p);
  const all: Array<ShowPanel | false> = [
    s.phase === 'gift_opening' && {
      key: 'opening',
      primary: ['gift_opening'],
      node: <OpeningControls eventId={eventId} />,
    },
    (s.phase === 'gift_opening' || s.phase === 'voting') && {
      key: 'voting',
      primary: ['voting'],
      node: <VotingControls eventId={eventId} phase={s.phase} />,
    },
    s.phase === 'reveal' && {
      key: 'reveal',
      primary: ['reveal'],
      node: <RevealControls eventId={eventId} />,
    },
    f.missions &&
      at('gift_registration') && {
        key: 'missions',
        primary: ['gift_registration'],
        node: <MissionsConsole eventId={eventId} />,
      },
    f.guessSanta &&
      at('gift_opening') && {
        key: 'clues',
        primary: ['gift_opening'],
        node: <ClueQueue eventId={eventId} />,
      },
    f.miniGames &&
      at('gift_opening') && {
        key: 'games',
        primary: ['games'],
        node: <GamesConsole eventId={eventId} />,
      },
    (f.guessSanta || f.missions) &&
      at('gift_opening') && {
        key: 'presentation',
        primary: ['gift_opening'],
        node: (
          <PresentationControls
            eventId={eventId}
            phase={s.phase}
            displayConnected={s.organizer.displayConnected === true}
          />
        ),
      },
    f.coins && { key: 'coins', primary: [], node: <CoinsConsole eventId={eventId} /> },
    f.auction && {
      key: 'auction',
      primary: ['games'],
      node: <AuctionConsole eventId={eventId} />,
    },
    at('voting') && {
      key: 'boards',
      primary: ['voting', 'games', 'reveal'],
      node: <BoardsConsole eventId={eventId} />,
    },
    (s.phase === 'awards' || s.phase === 'completed') && {
      key: 'ceremony',
      primary: ['awards', 'completed'],
      node: <CeremonyControls eventId={eventId} />,
    },
  ];
  const visible = all.filter((p): p is ShowPanel => !!p);
  const first = visible.filter((p) => p.primary.includes(s.phase));
  return [...first, ...visible.filter((p) => !first.includes(p))];
}

/** Show: run-of-show consoles, contextual to the current phase. */
export function ShowTab({ eventId, state }: TabProps) {
  const { t } = useTranslation();
  const panels = showPanels(eventId, state);
  if (!panels.length) return <p>{t('console.showEmpty')}</p>;
  return (
    <>
      {panels.map((p) => (
        <div key={p.key} data-testid={`show-${p.key}`}>
          {p.node}
        </div>
      ))}
    </>
  );
}

/** Admin: stats, integrity, moderation, unmask, archive, audit. */
export function AdminTab({ eventId, state: s }: TabProps) {
  const { t } = useTranslation();
  const f = featuresOf(s);
  return (
    <>
      <p className="text-sm">{t('console.masked')}</p>
      <StatsCard eventId={eventId} />
      {atOrPast(s.phase, 'voting') && <IntegrityPanel eventId={eventId} />}
      {atOrPast(s.phase, 'gift_registration') && <GiftModerationPanel eventId={eventId} />}
      <UnmaskForm eventId={eventId} />
      {f.history && <ArchiveConsole eventId={eventId} />}
      <AuditViewer eventId={eventId} />
    </>
  );
}
