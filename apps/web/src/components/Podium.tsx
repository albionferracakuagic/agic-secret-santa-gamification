import { useTranslation } from 'react-i18next';
import type { PublicLeaderboardOutput } from '@santa/contracts';

type Entry = PublicLeaderboardOutput['entries'][number];
const MEDAL = ['👑', '✨', '✨'];

/** Top-N podium from the leaderboard projection only: label, rank, tie flag. Nothing else is rendered. */
export function Podium({
  board,
  big = false,
}: {
  board: PublicLeaderboardOutput | undefined;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const entries: Entry[] = board && board.state !== 'hidden' ? board.entries : [];
  if (entries.length === 0)
    return <p className={big ? 'text-4xl' : ''}>{t('display.boardSoon')}</p>;
  return (
    <ol
      className={`flex items-end justify-center ${big ? 'gap-10' : 'gap-3'}`}
      data-testid="podium"
    >
      {entries.map((e) => (
        <li
          key={e.entryId}
          className={`flex flex-col items-center justify-end rounded-t-3xl bg-white/15 ${big ? 'w-[360px] px-6 py-8' : 'w-28 px-2 py-3'}`}
          style={{ minHeight: `${(big ? 1 : 0.35) * Math.max(180, 460 - e.rank * 70)}px` }}
        >
          <span aria-hidden="true" className={big ? 'text-7xl' : 'text-3xl'}>
            {MEDAL[e.rank - 1] ?? '⭐'}
          </span>
          <span className={`${big ? 'text-5xl' : 'text-xl'} font-bold`}>#{e.rank}</span>
          <span className={big ? 'text-4xl' : 'text-sm'}>{e.label}</span>
          {e.tied && <span className={big ? 'text-2xl' : 'text-xs'}>{t('display.tied')}</span>}
        </li>
      ))}
    </ol>
  );
}
