import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SceneOutput } from '@santa/contracts';
import { usePhase3Api } from '../../api/phase3';
import { Countdown } from '../Countdown';
import { useLocalized } from '../../lib/localized';
import { errorKey } from '../../pages/Dashboard';

/** FR-033: the caller's OWN balance and ledger. There is no coin leaderboard and nobody else's balance is ever shown. */
export function CoinsPanel() {
  const { t, i18n } = useTranslation();
  const api = usePhase3Api();
  const q = useQuery({ queryKey: ['coins'], queryFn: () => api.myCoins() });
  const s = q.data;
  if (!s?.enabled) return null;
  return (
    <section aria-labelledby="coins-title" className="space-y-2" data-testid="coins-panel">
      <h2 id="coins-title" className="text-xl font-semibold">
        🪙 {t('coins.title')}
      </h2>
      <p>{t('coins.privateNote')}</p>
      <p className="text-lg font-bold" data-testid="coin-balance">
        {t('coins.balance', { n: s.balance })}
      </p>
      {s.held > 0 && <p>{t('coins.held', { n: s.held })}</p>}
      {s.entries.length === 0 ? (
        <p>{t('coins.none')}</p>
      ) : (
        <>
          <h3 className="font-semibold">{t('coins.ledger')}</h3>
          <ul className="space-y-1">
            {s.entries.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {t(`coins.reason.${e.reason}`)}: {e.amount > 0 ? '+' : ''}
                {e.amount}{' '}
                <span className="text-sm">
                  {new Date(e.at).toLocaleTimeString(i18n.language, { timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** FR-034: the prize on stage, the current price and the caller's own position ("you are leading"; never anyone else's bid). */
export function AuctionPanel({
  scene,
  now,
}: {
  scene: SceneOutput | undefined;
  now: () => number;
}) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const loc = useLocalized();
  const qc = useQueryClient();
  const live = scene?.scene === 'auction';
  const q = useQuery({
    queryKey: ['auction'],
    queryFn: () => api.myAuction(),
    refetchInterval: live ? 4000 : false,
  });
  const sig =
    scene?.scene === 'auction'
      ? `${scene.auction.prizeId}|${scene.auction.status}|${scene.auction.currentBid}|${scene.auction.endsAt}`
      : 'none';
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['auction'] });
  }, [sig, qc]);
  const s = q.data;
  const prize = s?.prize;
  const [amount, setAmount] = useState('');
  const [extended, setExtended] = useState(false);
  const [wasLeading, setWasLeading] = useState(false);
  const leading = !!s?.you?.leading;
  useEffect(() => {
    if (wasLeading && !leading) setWasLeading(false);
    if (leading) setWasLeading(true);
  }, [leading, wasLeading]);
  const place = useMutation({
    mutationFn: (n: number) => api.placeBid(n),
    onSuccess: (r) => {
      setExtended(r.extended);
      setAmount('');
      void qc.invalidateQueries({ queryKey: ['auction'] });
      void qc.invalidateQueries({ queryKey: ['coins'] });
    },
  });
  if (!s?.enabled || !prize) return null;

  const spendable = s.balance + (leading ? (s.you?.myBid ?? 0) : 0);
  const n = Number(amount);
  const problem =
    amount.trim() === ''
      ? null
      : !Number.isInteger(n)
        ? t('auction.notWhole')
        : n < prize.minNextBid
          ? t('auction.tooLow', { n: prize.minNextBid })
          : n > spendable
            ? t('auction.tooMuch', { n: spendable })
            : null;
  const open = prize.status === 'open' && (!prize.endsAt || Date.parse(prize.endsAt) > now());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem && amount.trim() !== '') place.mutate(n);
  };
  return (
    <section aria-labelledby="auction-title" className="space-y-3" data-testid="auction-panel">
      <h2 id="auction-title" className="text-xl font-semibold">
        🎁 {t('auction.title')}
      </h2>
      <p className="font-semibold">{loc(prize.title)}</p>
      <p role="status">{t(`auction.status.${prize.status}`)}</p>
      {prize.status === 'open' && prize.endsAt && (
        <Countdown endsAt={prize.endsAt} now={now} className="text-3xl" />
      )}
      <p className="text-lg font-bold" data-testid="auction-price">
        {prize.currentBid === null
          ? t('auction.noBids', { n: prize.minNextBid })
          : t('auction.price', { n: prize.currentBid })}
      </p>
      {leading && (
        <p role="status" className="rounded bg-gold-400 p-3 font-semibold text-ink-900">
          {t('auction.leading')}
        </p>
      )}
      {!leading && wasLeading && <p role="status">{t('auction.outbid')}</p>}
      {extended && <p role="status">{t('auction.extended')}</p>}
      {open && (
        <form onSubmit={submit} className="space-y-2">
          <p>{t('auction.minNext', { n: prize.minNextBid })}</p>
          <label className="block">
            {t('auction.yourBid')}
            <input
              inputMode="numeric"
              className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3"
              value={amount}
              aria-invalid={!!problem}
              aria-describedby="bid-problem"
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <p id="bid-problem" role="alert" className="min-h-6">
            {problem ?? ''}
            {place.isError ? t(errorKey(place.error)) : ''}
          </p>
          <button
            className="min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50"
            disabled={amount.trim() === '' || !!problem || place.isPending || leading}
          >
            {t('auction.bid')}
          </button>
        </form>
      )}
      {prize.status !== 'open' && (
        <p>
          {prize.winner
            ? t('auction.winner', { name: prize.winner.displayName })
            : t('auction.nobody')}
        </p>
      )}
      {prize.reveal && <RevealBox text={loc(prize.reveal)} />}
    </section>
  );
}

/** Procedural box-open reveal (CSS only; the lid animation is skipped for reduced motion). */
export function RevealBox({ text, big = false }: { text: string; big?: boolean }) {
  const { t } = useTranslation();
  return (
    <p
      data-testid="mystery-reveal"
      className={`rounded bg-gold-400 p-3 font-bold text-ink-900 motion-safe:animate-bounce ${big ? 'text-6xl' : ''}`}
    >
      <span aria-hidden="true">✨🎁 </span>
      {t('auction.inside', { reveal: text })}
    </p>
  );
}
