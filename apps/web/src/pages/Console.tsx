import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Phase } from '@santa/contracts';
import { api } from '../api/client';
import { useOrganizer } from '../auth/session';
import { UnmaskBanner, UnmaskProvider } from '../components/organizer/Unmask';
import { ConsoleHeader } from '../components/organizer/console/ConsoleHeader';
import { ConsoleTabs } from '../components/organizer/console/ConsoleTabs';
import {
  AutopilotChip,
  autopilotOf,
  LiveTab,
} from '../components/organizer/console/LiveTab';
import { AdminTab, PeopleTab, SetupTab, ShowTab } from '../components/organizer/console/tabs';
import {
  parseTab,
  type ConsoleTab,
  type OrganizerState,
} from '../components/organizer/console/types';

export { nextPhase, prevPhase } from '../components/organizer/console/types';

export default function Console() {
  return (
    <UnmaskProvider>
      <ConsoleInner />
    </UnmaskProvider>
  );
}

/** Organizer cockpit: sticky header + tabs (Live · Setup · People · Show · Admin), deep-linkable via `?tab=`. */
function ConsoleInner() {
  const { t } = useTranslation();
  const { eventId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const setTab = (next: ConsoleTab) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        q.set('tab', next);
        return q;
      },
      { replace: true },
    );
  const [displayUrl, setDisplayUrl] = useState<string>();
  const me = useOrganizer();
  const qc = useQueryClient();
  const key = ['event', eventId];
  const state = useQuery({
    queryKey: key,
    enabled: !!me.data,
    refetchInterval: 15_000,
    queryFn: () => api<OrganizerState>(`/api/events/${eventId}/organizer-state`),
  });
  const act = useMutation({
    mutationFn: (a: { path: string; body: unknown }) =>
      api(`/api/events/${eventId}/${a.path}`, { method: 'POST', body: a.body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  if (me.isLoading || state.isLoading) return <p>{t('a11y.loading')}</p>;
  if (!me.data) return <Navigate to="/o/signin" replace />;
  const s = state.data?.eventState;
  if (!s) return <p role="alert">{t('error.forbidden')}</p>;

  const actions = {
    go: (to: Phase) => act.mutate({ path: 'phase', body: { to } }),
    togglePause: () => act.mutate({ path: 'pause', body: { paused: !s.paused } }),
    pending: act.isPending,
    error: act.isError ? act.error : null,
  };

  return (
    <div className="space-y-4 pb-40" /* room above fixed bottom notices */>
      <ConsoleHeader
        name={s.name}
        phase={s.phase}
        paused={s.paused}
        displayUrl={displayUrl}
        eventDetailsHref={`/o/events/${encodeURIComponent(eventId)}`}
        displaySetupHref={`/o/events/${eventId}?tab=people`}
        banner={<UnmaskBanner eventId={eventId} />}
        autopilotChip={<AutopilotChip state={autopilotOf(s)} />}
      />
      <ConsoleTabs active={tab} onChange={setTab}>
        {tab === 'live' && <LiveTab state={s} actions={actions} />}
        {tab === 'setup' && <SetupTab eventId={eventId} state={s} />}
        {tab === 'people' && (
          <PeopleTab
            eventId={eventId}
            state={s}
            onAccessLink={(l) => {
              if (l.kind === 'display') setDisplayUrl(new URL(l.path, location.origin).toString());
            }}
          />
        )}
        {tab === 'show' && <ShowTab eventId={eventId} state={s} />}
        {tab === 'admin' && <AdminTab eventId={eventId} state={s} />}
      </ConsoleTabs>
    </div>
  );
}
