import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { REACTION_KINDS, type ReactionKind, type RevealViewOutput } from '@santa/contracts';
import { effectiveIntensity, usePrefs } from '../../prefs/store';
import { useFxCap } from '../../fx/cap';
import { avatarGlyph } from '../../fx/avatars';
import { RECAP_PATH } from '../../routes/recap';
import { REACTION_GLYPH, floatReaction } from '../../fx/reactions';
import { createReactionThrottle } from '../reactionThrottle';

const SUSPENSE_MS = 1500;
const storeKey = (giftId: string) => `reveal-dismissed:${giftId}`;
const wasDismissed = (giftId: string) => {
  try {
    return sessionStorage.getItem(storeKey(giftId)) === '1';
  } catch {
    return false;
  }
};
const persistDismissed = (giftId: string) => {
  try {
    sessionStorage.setItem(storeKey(giftId), '1');
  } catch {
    /* in-memory state still applies */
  }
};

type Pair = Extract<NonNullable<RevealViewOutput['current']>, { stage: 'revealed' }>;

function PairLabel({ giver, recipient }: { giver: string; recipient: string }) {
  const { t } = useTranslation();
  return (
    <>
      <span aria-hidden="true">{t('reveal.pair', { giver, recipient })}</span>
      <span className="sr-only">{t('reveal.announceRevealed', { giver, recipient })}</span>
    </>
  );
}

/**
 * Participant side of the giver reveal. Only my own gift gets the full-screen moment; others get a quiet
 * status line (public data the display shows anyway). While my gift is in the drumroll nothing but the banner shows.
 */
export function RevealPersonal({
  reveal,
  myId,
  sendReaction,
}: {
  reveal: RevealViewOutput;
  myId: string;
  sendReaction: (k: ReactionKind) => void;
}) {
  const { t } = useTranslation();
  const { current, revealedCount, total } = reveal;
  const [mine, setMine] = useState<Pair>();
  const [closed, setClosed] = useState<Set<string>>(new Set());

  // Latch my revealed pair so the overlay survives the server moving on to the next gift.
  useEffect(() => {
    if (current?.stage === 'revealed' && current.recipient?.participantId === myId) {
      if (!wasDismissed(current.giftId)) setMine((m) => m ?? current);
    }
  }, [current, myId]);

  const dismiss = (giftId: string) => {
    persistDismissed(giftId);
    setClosed((s) => new Set(s).add(giftId));
    setMine(undefined);
  };

  const finale = current === null && total > 0 && revealedCount >= total;
  const myDrumroll = current?.stage === 'drumroll' && current.recipient?.participantId === myId;
  const other =
    current?.stage === 'revealed' && current.recipient?.participantId !== myId ? current : null;

  return (
    <section aria-label={t('reveal.title')} className="space-y-2" data-testid="reveal-personal">
      <div role="status" data-testid="reveal-personal-live">
        {myDrumroll && (
          <p
            className="rounded bg-gold-400 p-3 font-semibold text-ink-900"
            data-testid="my-drumroll"
          >
            🥁 {t('reveal.personal.drumroll')}
          </p>
        )}
        {other?.recipient && (
          <p className="rounded bg-pine-900 p-3 text-white" data-testid="reveal-toast">
            <PairLabel giver={other.giver.displayName} recipient={other.recipient.displayName} />
          </p>
        )}
        {finale && <p className="font-semibold">{t('reveal.finaleAnnounce')}</p>}
      </div>
      {finale && (
        <Link
          to={RECAP_PATH}
          data-testid="reveal-recap-link"
          className="flex min-h-12 items-center justify-center rounded-2xl bg-gold-400 px-4 py-3 text-lg font-bold text-ink-900"
        >
          <span aria-hidden="true">🎄</span>&nbsp;{t('reveal.personal.recap')}
        </Link>
      )}
      {mine && !closed.has(mine.giftId) && (
        <Overlay pair={mine} onDismiss={() => dismiss(mine.giftId)} sendReaction={sendReaction} />
      )}
    </section>
  );
}

function Overlay({
  pair,
  onDismiss,
  sendReaction,
}: {
  pair: Pair;
  onDismiss: () => void;
  sendReaction: (k: ReactionKind) => void;
}) {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const cap = useFxCap((s) => s.cap);
  const animate = effectiveIntensity(prefs, cap) !== 'off';
  const [suspense, setSuspense] = useState(animate);
  const btn = useRef<HTMLButtonElement>(null);
  const throttle = useRef(createReactionThrottle({}));
  useEffect(() => {
    if (!suspense) return;
    const id = setTimeout(() => setSuspense(false), SUSPENSE_MS);
    return () => clearTimeout(id);
  }, [suspense]);
  useEffect(() => {
    const previous = document.activeElement;
    btn.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    } else if (e.key === 'Tab') {
      const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    }
  };

  return (
    <div
      role="dialog"
      onKeyDown={onKeyDown}
      aria-modal="true"
      aria-label={t('reveal.personal.dialog')}
      data-testid="reveal-overlay"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-y-auto bg-pine-900 p-6 text-center text-white"
    >
      <h2 className="text-3xl font-bold">{t('reveal.personal.title')}</h2>
      <div className="space-y-3" data-testid={suspense ? undefined : 'reveal-overlay-giver'}>
        <p role="status" className="text-4xl font-extrabold text-gold-400 wrap-anywhere">
          {!suspense &&
            (pair.recipient ? (
              <PairLabel giver={pair.giver.displayName} recipient={pair.recipient.displayName} />
            ) : (
              t('reveal.secretSanta', { name: pair.giver.displayName })
            ))}
        </p>
        {suspense ? (
          <p aria-hidden="true" className="reveal-pulse text-8xl">
            🥁
          </p>
        ) : (
          <div className="space-y-3">
            <p aria-hidden="true" className={`text-9xl ${animate ? 'reveal-zoom' : ''}`}>
              {avatarGlyph(pair.giver.avatar)}
            </p>
            <p className="text-xl">{t('reveal.personal.gift', { name: pair.giftName })}</p>
            <div
              role="group"
              aria-label={t('reveal.personal.thanks')}
              className="flex flex-wrap justify-center gap-2"
            >
              {REACTION_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-label={t(`reactions.kind.${k}`)}
                  data-testid={`reveal-react-${k}`}
                  className="min-h-12 min-w-12 rounded-full bg-white text-2xl"
                  onClick={() => {
                    if (!throttle.current.tryAcquire()) return;
                    sendReaction(k);
                    floatReaction(k);
                  }}
                >
                  <span aria-hidden="true">{REACTION_GLYPH[k]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <button
        ref={btn}
        type="button"
        className="min-h-12 rounded bg-gold-400 px-6 font-semibold text-ink-900"
        onClick={onDismiss}
      >
        {t('reveal.personal.dismiss')}
      </button>
    </div>
  );
}
