import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REACTION_KINDS, type ReactionKind } from '@santa/contracts';
import { REACTION_GLYPH, floatReaction } from '../fx/reactions';
import { createReactionThrottle } from './reactionThrottle';

/** Positive-only reactions. Cooling down is communicated neutrally (never as an error) and never blocks other input. */
export function ReactionBar({ send }: { send: (kind: ReactionKind) => void }) {
  const { t } = useTranslation();
  const throttle = useRef(createReactionThrottle({}));
  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const press = (kind: ReactionKind) => {
    if (!throttle.current.tryAcquire()) {
      setCooling(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCooling(false), throttle.current.waitMs() + 20);
      return;
    }
    setCooling(false);
    send(kind);
    floatReaction(kind);
  };

  return (
    <section aria-labelledby="reactions-title" className="space-y-2">
      <h2 id="reactions-title" className="font-semibold">
        {t('reactions.title')}
      </h2>
      <div role="group" aria-label={t('reactions.title')} className="flex flex-wrap gap-2">
        {REACTION_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-label={t(`reactions.kind.${k}`)}
            aria-disabled={cooling}
            data-testid={`reaction-${k}`}
            className="min-h-12 min-w-12 rounded-full border border-ink-900/30 bg-white text-2xl aria-disabled:opacity-60"
            onClick={() => press(k)}
          >
            <span aria-hidden="true">{REACTION_GLYPH[k]}</span>
          </button>
        ))}
      </div>
      <p role="status" className="min-h-6 text-sm text-ink-900">
        {cooling ? t('reactions.cooling') : ''}
      </p>
    </section>
  );
}
