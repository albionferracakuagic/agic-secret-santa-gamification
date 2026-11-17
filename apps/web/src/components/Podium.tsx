import { useTranslation } from 'react-i18next';
import type { PublicLeaderboardOutput } from '@santa/contracts';

type Entry = PublicLeaderboardOutput['entries'][number];
export type BoardsOutput = { boards: PublicLeaderboardOutput[] };
const MEDAL = ['👑', '✨', '✨'];

export function useBoardName() {
  const { t } = useTranslation();
  return (key: string) => t(`board.${key}`, { defaultValue: key.replace(/_/g, ' ') });
}

/** Top-N podium from one board projection only: label, rank, tie flag. `christmas_magic` = neutral fallback. */
export function Podium({
  board,
  big = false,
}: {
  board: PublicLeaderboardOutput | undefined;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const entries: Entry[] = board && board.state !== 'hidden' ? board.entries : [];
  if (board?.message === 'christmas_magic' && entries.length === 0)
    return <p className={big ? 'text-4xl' : ''}>{t('display.christmasMagic')}</p>;
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

/** All published boards (surface `leaderboards`): hidden boards are omitted; unsafe ones show the neutral message. */
export function BoardsView({
  boards,
  big = false,
}: {
  boards: BoardsOutput | undefined;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const name = useBoardName();
  const visible = boards?.boards.filter((b) => b.state !== 'hidden') ?? [];
  if (visible.length === 0) return <Podium board={undefined} big={big} />;
  return (
    <div className={big ? 'space-y-12' : 'space-y-4'} data-testid="boards">
      {visible.map((b) => (
        <section key={b.boardKey} aria-label={name(b.boardKey)} data-board={b.boardKey}>
          <h3 className={`${big ? 'mb-6 text-5xl' : 'mb-1 font-semibold'}`}>
            {name(b.boardKey)}
            {b.state === 'paused' && (
              <span className="ml-2 text-base">({t('display.paused')})</span>
            )}
          </h3>
          <Podium board={b} big={big} />
        </section>
      ))}
    </div>
  );
}
