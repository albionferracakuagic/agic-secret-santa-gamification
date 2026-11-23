import { useId, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SHOW_CHOICE_SECONDS, type SceneOutput } from '@santa/contracts';
import { useTranslation } from 'react-i18next';
import { hasApiCode } from '../../api/client';
import { revealShowApi } from '../../api/revealShow';
import { errorKey } from '../../pages/Dashboard';
import { surfaceOf, useRealtime } from '../../realtime/react';

export function RevealChoiceShowPanel({ eventId, paused }: { eventId: string; paused: boolean }) {
  const { state } = useRealtime(eventId);
  return (
    <RevealChoiceControls
      eventId={eventId}
      paused={paused}
      scene={surfaceOf<SceneOutput>(state, 'pub', 'scene')}
    />
  );
}

export function RevealChoiceControls({
  eventId,
  paused,
  scene,
}: {
  eventId: string;
  paused: boolean;
  scene?: SceneOutput | undefined;
}) {
  const { t } = useTranslation();
  const heading = useId();
  const qc = useQueryClient();
  const key = ['host-reveal-show', eventId] as const;
  const busy = useRef(false);
  const state = useQuery({
    queryKey: key,
    queryFn: () => revealShowApi.state(eventId),
    refetchInterval: (q) => (q.state.data?.choice?.status === 'open' ? 1000 : 3000),
    retry: false,
  });
  const command = useMutation({
    mutationFn: async (cancel: boolean) => {
      await qc.cancelQueries({ queryKey: key });
      return revealShowApi.round(eventId, cancel);
    },
    onSuccess: (value) => qc.setQueryData(key, value),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: key });
      busy.current = false;
    },
  });
  if (!state.data) {
    return state.isError ? <p role="status">{t('revealShow.hostUnavailable')}</p> : null;
  }
  const choice = state.data.choice;
  const open = choice?.status === 'open';
  const stageBusy =
    scene?.scene === 'game' ||
    scene?.scene === 'auction' ||
    scene?.scene === 'spotlight' ||
    scene?.scene === 'ceremony' ||
    (scene?.scene === 'reveal' && scene.reveal.current?.stage === 'drumroll');
  if ((paused || stageBusy) && !open) return null;
  return (
    <section aria-labelledby={heading} className="space-y-2 rounded-xl border border-pine-700 p-3">
      <h2 id={heading} className="font-bold">
        {t('revealShow.matchup')}
      </h2>
      <p role="status">
        {open
          ? t('revealShow.hostOpen')
          : choice?.status === 'closed'
            ? t(`revealShow.result.${choice.result}`)
            : t('revealShow.hostHint', { count: SHOW_CHOICE_SECONDS })}
      </p>
      <button
        type="button"
        data-testid={open ? 'reveal-choice-cancel' : 'reveal-choice-start'}
        aria-disabled={command.isPending}
        className="min-h-12 rounded-lg bg-pine-900 px-4 font-semibold text-white aria-disabled:opacity-70"
        onClick={() => {
          if (busy.current) return;
          busy.current = true;
          command.mutate(open);
        }}
      >
        {t(open ? 'revealShow.cancel' : 'revealShow.start')}
      </button>
      {command.error && (
        <p role="alert">
          {t(
            hasApiCode(command.error, 'stage_busy')
              ? 'revealShow.stageBusy'
              : errorKey(command.error),
          )}
        </p>
      )}
    </section>
  );
}
