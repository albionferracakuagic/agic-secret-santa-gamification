import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuctionViewOutput, GameViewOutput, SpotlightOutput } from '@santa/contracts';
import { Countdown } from './Countdown';
import { Winners } from './play/GamePanel';
import { RevealBox } from './play/AuctionPanel';
import { useLocalized } from '../lib/localized';

const Frame = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section
    aria-label={title}
    className="flex h-full w-full flex-col items-center justify-center gap-10 p-24 text-center"
  >
    <h2 className="text-8xl font-bold">{title}</h2>
    {children}
  </section>
);

/** Display scene of the active mini-game: identical for every viewer, top-N winners only (no scores, no totals). */
export function GameScene({ game, now }: { game: GameViewOutput; now: () => number }) {
  const { t } = useTranslation();
  const loc = useLocalized();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const round = game.round;
  const title = `${t(`game.kind.${game.kind}`)}${game.title ? ` — ${loc(game.title)}` : ''}`;
  const waiting = round?.opensAt ? Date.parse(round.opensAt) > now() : false;
  return (
    <Frame title={title}>
      <div data-testid="game-scene" data-status={game.status} className="space-y-8">
        {game.status === 'intro' && (
          <>
            <p className="text-5xl">{t('display.gameIntro')}</p>
            <p className="max-w-[1400px] text-4xl">{loc(game.rules)}</p>
            {game.stepEndsAt && (
              <Countdown endsAt={game.stepEndsAt} now={now} className="text-[10rem]" />
            )}
          </>
        )}
        {round && game.status !== 'intro' && game.status !== 'results' && (
          <>
            <p className="text-4xl">
              {t('game.round', { n: round.index + 1, total: round.total })}
            </p>
            <p className="text-6xl font-semibold">{loc(round.prompt)}</p>
            {round.options.length > 0 && (
              <ul className="grid max-w-[1500px] grid-cols-2 gap-6 text-4xl">
                {round.options.map((o) => (
                  <li key={o.id} className="rounded-2xl bg-white/15 px-8 py-5">
                    {loc(o.label)}
                    {round.correctOptionIds?.includes(o.id) && <span> ✅</span>}
                  </li>
                ))}
              </ul>
            )}
            {game.status === 'round_open' && game.kind === 'speed' && (
              <p className="text-7xl font-extrabold text-gold-400">
                {waiting ? t('game.getReady') : `⭐ ${t('game.tap')}`}
              </p>
            )}
            {game.status === 'round_open' && round.endsAt && (
              <Countdown endsAt={round.endsAt} now={now} className="text-[9rem]" />
            )}
            {game.status === 'round_open' && (
              <p className="text-5xl" data-testid="submission-count">
                {t('game.answeredCount', { n: round.submissionCount })}
              </p>
            )}
          </>
        )}
        {game.status === 'results' && game.results && <Winners big results={game.results} />}
      </div>
    </Frame>
  );
}

/** Santa Detective / Invisible Santa / Mission Master: canPublish-gated; `christmas_magic` is the neutral fallback. */
export function SpotlightScene({ spotlight }: { spotlight: SpotlightOutput }) {
  const { t } = useTranslation();
  return (
    <Frame title={t(`guessCtl.kind.${spotlight.kind}`)}>
      <div data-testid="spotlight-scene">
        <Winners big results={spotlight} />
      </div>
    </Frame>
  );
}

/** Display auction: only the current price (never bidders or bid counts); the winner is named once closed, the content after the reveal. */
export function AuctionScene({ auction, now }: { auction: AuctionViewOutput; now: () => number }) {
  const { t } = useTranslation();
  const loc = useLocalized();
  return (
    <Frame title={`${t('display.auctionTitle')} — ${loc(auction.title)}`}>
      <div data-testid="auction-scene" data-status={auction.status} className="space-y-8">
        <p className="text-5xl">{t(`auction.status.${auction.status}`)}</p>
        <p className="text-[9rem] font-extrabold text-gold-400" data-testid="auction-price">
          🪙 {auction.currentBid ?? auction.minNextBid}
        </p>
        <p className="text-4xl">{t('auction.minNext', { n: auction.minNextBid })}</p>
        {auction.status === 'open' && auction.endsAt && (
          <Countdown endsAt={auction.endsAt} now={now} className="text-[9rem]" />
        )}
        {auction.status !== 'open' && (
          <p className="text-6xl">
            {auction.winner
              ? t('auction.winner', { name: auction.winner.displayName })
              : t('auction.nobody')}
          </p>
        )}
        {auction.reveal && <RevealBox big text={loc(auction.reveal)} />}
      </div>
    </Frame>
  );
}
