import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { AutopilotCommand, AutopilotState, Phase } from '@santa/contracts';
import { useOrganizerApi } from '../../../api/organizer';
import { errorKey } from '../../../pages/Dashboard';
import { nextPhase, prevPhase, type OrganizerEventState } from './types';
import { useAutopilot } from './useAutopilot';

export interface PhaseActions {
  go: (to: Phase) => void;
  togglePause: () => void;
  pending: boolean;
  error: unknown;
}

type OrganizerAutopilotState = OrganizerEventState['organizer'] & {
  autopilot?: AutopilotState | undefined;
};

export const autopilotOf = (state: OrganizerEventState): AutopilotState | undefined =>
  (state.organizer as OrganizerAutopilotState).autopilot;

/**
 * Live tab = cockpit. Layout (top → bottom):
 *  1. `cockpit` slot — autopilot card, timeline, live stats.
 *  2. Warnings.
 *  3. "Manual override" — the existing manual phase/pause controls.
 */
export function LiveTab({
  state,
  actions,
  cockpit,
}: {
  state: OrganizerEventState;
  actions: PhaseActions;
  cockpit?: ReactNode | undefined;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div data-testid="live-cockpit" className="space-y-4">
        {cockpit ?? (
          <LiveCockpit state={state}>
            <AutopilotPanel state={state} />
          </LiveCockpit>
        )}
      </div>
      {state.organizer.warnings.map((w) => (
        <p key={w} role="alert" className="rounded border-2 border-gold-700 bg-snow-100 p-3">
          {t(`console.warnings.${w}`)}
        </p>
      ))}
      <ManualOverride state={state} actions={actions} />
    </>
  );
}

/** Organizer-only status chip used in the sticky console header. */
export function AutopilotChip({ state }: { state?: AutopilotState | undefined }) {
  const { t } = useTranslation();
  const status = state?.status ?? 'idle';
  const palette =
    status === 'running'
      ? 'bg-pine-900 text-white'
      : status === 'held'
        ? 'bg-gold-400 text-ink-900'
        : 'border border-ink-900 text-ink-900';
  return (
    <span
      role="status"
      data-testid={`autopilot-chip-${status}`}
      className={`inline-flex min-h-8 items-center rounded-full px-3 text-sm font-semibold ${palette}`}
    >
      {t(`autopilot.status.${status}`)}
    </span>
  );
}

/** Read-only "at a glance" numbers already present in the organizer projection (no extra fetch). */
export function LiveCockpit({
  state,
  children,
}: {
  state: OrganizerEventState;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const r = state.organizer.roster;
  const items: Array<[string, number]> = [
    [t('console.live.participants'), state.counts.participants],
    [t('console.live.gifts'), state.counts.giftsRegistered],
    [t('console.live.joined'), r.active],
    [t('console.live.pending'), r.pending],
  ];
  return (
    <section aria-labelledby="live-summary-title" className="space-y-2">
      <h2 id="live-summary-title" className="text-xl font-semibold">
        {t('console.live.title')}
      </h2>
      <p>
        {t('console.currentPhase')}: <strong>{t(`phase.${state.phase}`)}</strong>
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map(([label, n]) => (
          <div key={label} className="rounded bg-snow-100 p-3">
            <dt className="text-sm">{label}</dt>
            <dd className="text-2xl font-bold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      <p>
        {t('console.roster')}:{' '}
        {t('console.rosterCounts', {
          active: r.active,
          pending: r.pending,
          unclaimed: r.unclaimed,
        })}
      </p>
      {children}
    </section>
  );
}

const IDLE_STATE: AutopilotState = {
  status: 'idle',
  step: null,
  seq: 0,
  stepEndsAt: null,
  startedAt: null,
  heldAt: null,
  remainingMsAtHold: null,
  timeline: [],
  log: [],
};

function AutopilotPanel({ state }: { state: OrganizerEventState }) {
  const { t } = useTranslation();
  const { eventId = '' } = useParams();
  const organizerApi = useOrganizerApi();
  const projected = autopilotOf(state);
  const autopilot = useAutopilot(eventId, projected);
  const current = autopilot.state ?? IDLE_STATE;
  const pairing = useQuery({
    queryKey: ['pairing-latest', eventId],
    queryFn: () => organizerApi.latestPairing(eventId),
    enabled: !!eventId,
  });
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (current.status !== 'running' || !current.stepEndsAt) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [current.status, current.stepEndsAt]);

  const readiness = [
    {
      key: 'pairing',
      ready: pairing.data?.import?.status === 'ready',
    },
    {
      key: 'gifts',
      ready: state.counts.giftsRegistered > 0,
    },
    {
      key: 'display',
      ready: autopilot.displayConnected,
    },
    {
      key: 'features',
      ready: !!state.organizer.features,
    },
  ] as const;
  const phaseAllowed = phaseAllowsStart(state.phase);
  const allReady = readiness.every((item) => item.ready) && phaseAllowed && !state.paused && !!projected;
  const pending = autopilot.command.isPending;
  const command = (action: AutopilotCommand['action']) =>
    autopilot.command.mutate({ action, fromSeq: current.seq });
  const error = autopilot.command.error ?? autopilot.query.error;

  return (
    <section
      aria-labelledby="autopilot-title"
      className="space-y-4 rounded border border-pine-900/30 bg-white p-4"
      data-testid="autopilot-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide">
            {t('autopilot.kicker')}
          </p>
          <h2 id="autopilot-title" className="text-xl font-semibold">
            {t('autopilot.title')}
          </h2>
        </div>
        <AutopilotChip state={current} />
      </div>

      {state.paused && current.status === 'held' && (
        <p role="status" className="rounded bg-gold-200 p-3" data-testid="autopilot-frozen">
          {t('autopilot.frozen', {
            remaining: formatRemaining(current.remainingMsAtHold ?? 0),
          })}
        </p>
      )}

      {current.status === 'idle' && (
        <div className="space-y-3">
          <h3 className="font-semibold">{t('autopilot.readiness.title')}</h3>
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="autopilot-readiness">
            {readiness.map((item) => (
              <li
                key={item.key}
                className="flex min-h-11 items-center justify-between gap-3 rounded bg-snow-100 p-3"
              >
                <span>{t(`autopilot.readiness.${item.key}`)}</span>
                <span
                  className="text-sm font-semibold"
                  aria-label={t(item.ready ? 'autopilot.readiness.ready' : 'autopilot.readiness.waiting')}
                >
                  {t(item.ready ? 'autopilot.readiness.ready' : 'autopilot.readiness.waiting')}
                </span>
              </li>
            ))}
          </ul>
          {!phaseAllowed && (
            <p className="text-sm">{t('autopilot.readiness.phase')}</p>
          )}
          {state.paused && <p className="text-sm">{t('autopilot.readiness.paused')}</p>}
          <button
            type="button"
            className="min-h-12 w-full rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50"
            disabled={!allReady || pending || pairing.isLoading}
            onClick={() => command('start')}
          >
            {t('autopilot.action.start')}
          </button>
        </div>
      )}

      {current.status !== 'idle' && (
        <>
          <CurrentStep state={current} eventPaused={state.paused} serverNow={autopilot.serverNow()} />
          <Timeline state={current} />
        </>
      )}

      {(current.status === 'running' || current.status === 'held') && (
        <div className="grid gap-2 sm:grid-cols-3" aria-label={t('autopilot.controls')}>
          {current.status === 'running' ? (
            <button
              type="button"
              className="min-h-12 rounded bg-gold-400 px-4 font-semibold text-ink-900 disabled:opacity-50"
              disabled={pending}
              onClick={() => command('hold')}
            >
              {t('autopilot.action.hold')}
            </button>
          ) : (
            <button
              type="button"
              className="min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50"
              disabled={pending || state.paused}
              onClick={() => command('resume')}
            >
              {t('autopilot.action.resume')}
            </button>
          )}
          {current.status === 'running' && (
            <button
              type="button"
              className="min-h-12 rounded border border-santa-700 px-4 font-semibold text-santa-800 disabled:opacity-50"
              disabled={pending}
              onClick={() => setConfirmSkip(true)}
            >
              {t('autopilot.action.skip')}
            </button>
          )}
          <button
            type="button"
            className="min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50"
            disabled={pending}
            onClick={() => command('stop')}
          >
            {t('autopilot.action.stop')}
          </button>
        </div>
      )}

      {confirmSkip && (
        <div
          role="alertdialog"
          aria-labelledby="skip-autopilot-title"
          aria-describedby="skip-autopilot-warning"
          className="space-y-3 rounded border-2 border-santa-700 bg-snow-100 p-4"
        >
          <h3 id="skip-autopilot-title" className="font-semibold">
            {t('autopilot.skipConfirm.title')}
          </h3>
          <p id="skip-autopilot-warning">{t('autopilot.skipConfirm.warning')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-11 rounded bg-santa-700 px-4 font-semibold text-white"
              disabled={pending}
              onClick={() => {
                command('skip');
                setConfirmSkip(false);
              }}
            >
              {t('autopilot.skipConfirm.confirm')}
            </button>
            <button
              type="button"
              className="min-h-11 rounded border border-ink-900 px-4 font-semibold"
              onClick={() => setConfirmSkip(false)}
            >
              {t('autopilot.skipConfirm.cancel')}
            </button>
          </div>
        </div>
      )}

      {current.log.length > 0 && <AutopilotLog entries={current.log} />}
      {error != null && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(error))}
        </p>
      )}
    </section>
  );
}

const phaseAllowsStart = (phase: Phase) =>
  phase !== 'preparation' &&
  phase !== 'registration' &&
  phase !== 'gift_registration' &&
  phase !== 'completed';

function CurrentStep({
  state,
  eventPaused,
  serverNow,
}: {
  state: AutopilotState;
  eventPaused: boolean;
  serverNow: number;
}) {
  const { t } = useTranslation();
  if (!state.step) return null;
  const remaining =
    state.status === 'held'
      ? (state.remainingMsAtHold ?? 0)
      : Math.max(0, new Date(state.stepEndsAt ?? serverNow).getTime() - serverNow);
  return (
    <div className="rounded bg-pine-950 p-4 text-white" aria-live="off">
      <p className="text-sm">{t('autopilot.currentStep')}</p>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <strong className="text-2xl">{t(`autopilot.step.${state.step}`)}</strong>
        {state.status !== 'done' && (
          <time
            className="text-3xl font-bold tabular-nums"
            dateTime={`PT${Math.ceil(remaining / 1_000)}S`}
            aria-label={t('autopilot.countdown', {
              time: formatRemaining(remaining),
            })}
          >
            {formatRemaining(remaining)}
          </time>
        )}
      </div>
      {state.status === 'held' && (
        <p className="mt-2 text-sm">
          {eventPaused ? t('autopilot.heldFrozen') : t('autopilot.heldByOrganizer')}
        </p>
      )}
    </div>
  );
}

function Timeline({ state }: { state: AutopilotState }) {
  const { t, i18n } = useTranslation();
  if (!state.timeline.length) return null;
  return (
    <section aria-labelledby="autopilot-timeline-title">
      <h3 id="autopilot-timeline-title" className="font-semibold">
        {t('autopilot.timeline.title')}
      </h3>
      <ol className="mt-2 space-y-2" data-testid="autopilot-timeline">
        {state.timeline.map((item) => (
          <li
            key={item.step}
            className={`flex flex-wrap items-center justify-between gap-2 rounded border p-3 ${
              item.status === 'active' ? 'border-pine-900 bg-pine-50' : 'border-ink-900/20'
            }`}
            data-status={item.status}
          >
            <span className="font-semibold">{t(`autopilot.step.${item.step}`)}</span>
            <span className="text-sm">
              {t(`autopilot.timeline.${item.status}`)}
              {item.eta && (
                <>
                  {' · '}
                  <time dateTime={item.eta}>
                    {new Date(item.eta).toLocaleTimeString(i18n.language, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </>
              )}
              {' · '}
              {t('autopilot.timeline.duration', {
                time: formatRemaining(item.plannedSeconds * 1_000),
              })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AutopilotLog({ entries }: { entries: AutopilotState['log'] }) {
  const { t, i18n } = useTranslation();
  return (
    <section aria-labelledby="autopilot-log-title">
      <h3 id="autopilot-log-title" className="font-semibold">
        {t('autopilot.logTitle')}
      </h3>
      <ol className="mt-2 space-y-1 text-sm" data-testid="autopilot-log">
        {entries
          .slice(-8)
          .reverse()
          .map((entry) => {
            const step = entry.params?.step;
            const params =
              typeof step === 'string'
                ? { ...entry.params, step: t(`autopilot.step.${step}`) }
                : entry.params;
            return (
              <li key={`${entry.at}-${entry.code}`} className="flex flex-wrap gap-x-2">
                <time className="tabular-nums text-ink-900/70" dateTime={entry.at}>
                  {new Date(entry.at).toLocaleTimeString(i18n.language, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </time>
                <span>
                  {params
                    ? t(`autopilot.log.${entry.code}`, params)
                    : t(`autopilot.log.${entry.code}`)}
                </span>
              </li>
            );
          })}
      </ol>
    </section>
  );
}

const formatRemaining = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Existing manual phase controls (unchanged behaviour), grouped under "Manual override". */
export function ManualOverride({
  state: s,
  actions: a,
}: {
  state: OrganizerEventState;
  actions: PhaseActions;
}) {
  const { t } = useTranslation();
  const next = nextPhase(s.phase);
  const prev = prevPhase(s.phase);
  const big = 'min-h-12 w-full rounded px-4 font-semibold disabled:opacity-50';
  return (
    <section aria-labelledby="manual-title" className="space-y-2" data-testid="manual-override">
      <h2 id="manual-title" className="text-xl font-semibold">
        {t('console.manual.title')}
      </h2>
      <p className="text-sm">{t('console.manual.hint')}</p>
      {next && (
        <button
          type="button"
          disabled={a.pending}
          className={`${big} bg-pine-900 text-white`}
          onClick={() => a.go(next)}
        >
          {t('console.next', { phase: t(`phase.${next}`) })}
        </button>
      )}
      {s.phase === 'voting' && (
        <button
          type="button"
          disabled={a.pending}
          className={`${big} border border-pine-900`}
          onClick={() => a.go('reveal')}
        >
          {t('console.skipGames')}
        </button>
      )}
      {prev && (
        <button
          type="button"
          disabled={a.pending}
          className={`${big} border border-ink-900`}
          onClick={() => a.go(prev)}
        >
          {t('console.previous', { phase: t(`phase.${prev}`) })}
        </button>
      )}
      <button
        type="button"
        disabled={a.pending}
        className={`${big} bg-santa-600 text-white`}
        onClick={a.togglePause}
      >
        {s.paused ? t('console.resume') : t('console.pause')}
      </button>
      {a.error != null && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(a.error))}
        </p>
      )}
    </section>
  );
}
