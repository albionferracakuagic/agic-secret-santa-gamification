import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PRIZE_ACTIONS,
  type EventFeatures,
  type FeaturesPatch,
  type Phase,
  type Phase2Settings,
  type Phase3Settings,
} from '@santa/contracts';
import { usePhase3Api, type OrganizerPrize, type PrizeAction } from '../../api/phase3';
import { useLocalized } from '../../lib/localized';
import { errorKey } from '../../pages/Dashboard';
import { ArchiveView, HallOfFameView } from '../play/HistoryPanel';

const btn = 'min-h-12 rounded border border-ink-900 px-4 font-semibold disabled:opacity-50';
const primary = 'min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50';
const field = 'mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3';

const Err = ({ e }: { e: unknown }) => {
  const { t } = useTranslation();
  return e ? (
    <p role="alert" className="rounded bg-santa-700 p-3 text-white">
      {t(errorKey(e))}
    </p>
  ) : null;
};

const SWITCHES = ['guessSanta', 'missions', 'miniGames', 'coins', 'auction', 'history'] as const;
type Switch = (typeof SWITCHES)[number];

/** Feature switches and Phase 2/3 rules. Locked states mirror the server: nothing after completion, nothing new ON in awards (except history), auction needs coins. */
export function FeaturesPanel({
  eventId,
  phase,
  features,
  phase2,
  phase3,
}: {
  eventId: string;
  phase: Phase;
  features: EventFeatures;
  phase2: Phase2Settings;
  phase3: Phase3Settings;
}) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const qc = useQueryClient();
  const done = phase === 'completed';
  const awards = phase === 'awards';
  const [saved, setSaved] = useState(false);
  const patch = useMutation({
    mutationFn: (p: FeaturesPatch) => api.updateFeatures(eventId, p),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['event', eventId] });
    },
  });
  const [rules, setRules] = useState({
    coin: { ...phase3.coinRules },
    auction: { ...phase3.auction },
    verification: phase2.missionVerification,
    perParticipant: phase2.missionsPerParticipant,
  });

  const lockReason = (k: Switch): string | null => {
    if (done) return t('features.lockedDone');
    if (awards && !features[k] && k !== 'history') return t('features.lockedAwards');
    if (k === 'auction' && !features.coins && !features.auction) return t('features.needsCoins');
    if (k === 'coins' && features.coins && features.auction) return t('features.needsAuctionOff');
    return null;
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    patch.mutate({
      phase2: {
        missionVerification: rules.verification,
        missionsPerParticipant: rules.perParticipant,
      },
      phase3: { coinRules: rules.coin, auction: rules.auction },
    });
  };
  const num = (label: string, v: number, set: (n: number) => void) => (
    <label className="block">
      {label}
      <input
        type="number"
        className={field}
        value={v}
        disabled={done}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  );
  return (
    <section aria-labelledby="features-title" className="space-y-3" data-testid="features-panel">
      <h2 id="features-title" className="text-xl font-semibold">
        {t('features.title')}
      </h2>
      <p>{t('features.intro')}</p>
      <ul className="space-y-2">
        {SWITCHES.map((k) => {
          const lock = lockReason(k);
          const id = `flag-${k}`;
          return (
            <li key={k} className="flex flex-wrap items-center gap-3">
              <input
                id={id}
                type="checkbox"
                role="switch"
                className="h-6 w-6"
                checked={features[k]}
                disabled={!!lock || patch.isPending}
                aria-describedby={lock ? `${id}-lock` : undefined}
                onChange={(e) => {
                  setSaved(false);
                  patch.mutate({ [k]: e.target.checked } as FeaturesPatch);
                }}
              />
              <label htmlFor={id}>{t(`features.flag.${k}`)}</label>
              {lock && (
                <span id={`${id}-lock`} className="text-sm">
                  🔒 {lock}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={submit} className="space-y-2">
        <h3 className="font-semibold">{t('features.rules')}</h3>
        <label className="block">
          {t('features.missionVerification')}
          <select
            className={field}
            disabled={done}
            value={rules.verification}
            onChange={(e) =>
              setRules({ ...rules, verification: e.target.value as 'none' | 'organizer' })
            }
          >
            {(['none', 'organizer'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`features.verification.${v}`)}
              </option>
            ))}
          </select>
        </label>
        {num(t('features.missionsPerParticipant'), rules.perParticipant, (n) =>
          setRules({ ...rules, perParticipant: n }),
        )}
        {(Object.keys(rules.coin) as Array<keyof typeof rules.coin>).map((k) =>
          num(t(`features.coinRule.${k}`), rules.coin[k], (n) =>
            setRules({ ...rules, coin: { ...rules.coin, [k]: n } }),
          ),
        )}
        {(Object.keys(rules.auction) as Array<keyof typeof rules.auction>).map((k) =>
          num(t(`features.auctionRule.${k}`), rules.auction[k], (n) =>
            setRules({ ...rules, auction: { ...rules.auction, [k]: n } }),
          ),
        )}
        <button className={primary} disabled={done || patch.isPending}>
          {t('features.save')}
        </button>
      </form>
      <p role="status">{saved ? t('features.saved') : ''}</p>
      <Err e={patch.error} />
    </section>
  );
}

/** Coins: rules summary + the one aggregate (never a person's balance) and organizer grants. */
export function CoinsConsole({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const qc = useQueryClient();
  const key = ['org-coins', eventId];
  const q = useQuery({ queryKey: key, queryFn: () => api.organizerCoins(eventId) });
  const [name, setName] = useState('');
  const [amount, setAmount] = useState(5);
  const grant = useMutation({
    mutationFn: () => api.grantCoins(eventId, { key: name.trim(), amount }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  if (!q.data?.enabled) return null;
  return (
    <section aria-labelledby="coins-ctl-title" className="space-y-2" data-testid="coins-console">
      <h2 id="coins-ctl-title" className="text-xl font-semibold">
        {t('coinsCtl.title')}
      </h2>
      <p>{t('coinsCtl.issued', { n: q.data.issued })}</p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          grant.mutate();
        }}
      >
        <h3 className="font-semibold">{t('coinsCtl.grantTitle')}</h3>
        <label className="block">
          {t('coinsCtl.key')}
          <input
            className={field}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block">
          {t('coinsCtl.amount')}
          <input
            type="number"
            className={field}
            min={1}
            max={1000}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </label>
        <button className={primary} disabled={name.trim().length < 3 || grant.isPending}>
          {t('coinsCtl.grant')}
        </button>
      </form>
      {grant.isSuccess && <p role="status">{t('coinsCtl.granted', { n: grant.data.granted })}</p>}
      <Err e={grant.error} />
    </section>
  );
}

const PRIZE_ACTIONS_BY_STATUS: Record<string, PrizeAction[]> = {
  draft: ['open', 'cancel'],
  open: ['close', 'cancel'],
  closed: ['reveal', 'dismiss'],
  revealed: ['dismiss'],
};

/** Prize CRUD plus the stage controls (start / close / reveal / clear). */
export function AuctionConsole({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const loc = useLocalized();
  const qc = useQueryClient();
  const key = ['org-prizes', eventId];
  const q = useQuery({ queryKey: key, queryFn: () => api.prizes(eventId), refetchInterval: 5000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const [title, setTitle] = useState('');
  const [reveal, setReveal] = useState('');
  const [minBid, setMinBid] = useState(1);
  const [duration, setDuration] = useState(60);
  const create = useMutation({
    mutationFn: () =>
      api.createPrize(eventId, {
        title: { en: title.trim() },
        reveal: { en: reveal.trim() },
        minBid,
      }),
    onSuccess: () => {
      setTitle('');
      setReveal('');
      refresh();
    },
  });
  const act = useMutation({
    mutationFn: (v: { id: string; action: PrizeAction }) =>
      api.prizeAction(eventId, v.id, v.action, v.action === 'open' ? duration : undefined),
    onSettled: refresh,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deletePrize(eventId, id),
    onSettled: refresh,
  });
  if (!q.data?.enabled) return null;
  const prizeLine = (p: OrganizerPrize) => (
    <li key={p.prizeId} className="space-y-2 rounded border border-ink-900/30 bg-white p-3">
      <p className="font-semibold">
        {loc(p.title)} {p.onStage && <span>· {t('auctionCtl.onStage')}</span>}
      </p>
      <p>{t('auctionCtl.status.' + p.status)}</p>
      {p.currentBid !== null && <p>{t('auctionCtl.currentBid', { n: p.currentBid })}</p>}
      {p.winner && <p>{t('auctionCtl.winner', { name: p.winner.displayName })}</p>}
      <div className="flex flex-wrap gap-2">
        {(PRIZE_ACTIONS_BY_STATUS[p.status] ?? [])
          .filter((a) => (PRIZE_ACTIONS as readonly string[]).includes(a))
          .map((a) => (
            <button
              key={a}
              type="button"
              className={a === 'cancel' || a === 'dismiss' ? btn : primary}
              disabled={act.isPending}
              aria-label={`${t(`auctionCtl.action.${a}`)}: ${loc(p.title)}`}
              onClick={() => act.mutate({ id: p.prizeId, action: a })}
            >
              {t(`auctionCtl.action.${a}`)}
            </button>
          ))}
        {p.status === 'draft' && (
          <button
            type="button"
            className={btn}
            disabled={del.isPending}
            aria-label={`${t('auctionCtl.delete')}: ${loc(p.title)}`}
            onClick={() => del.mutate(p.prizeId)}
          >
            {t('auctionCtl.delete')}
          </button>
        )}
      </div>
    </li>
  );
  return (
    <section
      aria-labelledby="auction-ctl-title"
      className="space-y-3"
      data-testid="auction-console"
    >
      <h2 id="auction-ctl-title" className="text-xl font-semibold">
        {t('auctionCtl.title')}
      </h2>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="block">
          {t('auctionCtl.titleLabel')}
          <input
            className={field}
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block">
          {t('auctionCtl.revealLabel')}
          <input
            className={field}
            value={reveal}
            maxLength={200}
            onChange={(e) => setReveal(e.target.value)}
          />
        </label>
        <label className="block">
          {t('auctionCtl.minBid')}
          <input
            type="number"
            className={field}
            min={1}
            value={minBid}
            onChange={(e) => setMinBid(Number(e.target.value))}
          />
        </label>
        <button className={primary} disabled={!title.trim() || !reveal.trim() || create.isPending}>
          {t('auctionCtl.create')}
        </button>
      </form>
      <label className="block">
        {t('auctionCtl.duration')}
        <input
          type="number"
          className={field}
          min={10}
          max={3600}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </label>
      {q.data.prizes.length === 0 ? (
        <p>{t('auctionCtl.empty')}</p>
      ) : (
        <ul className="space-y-3">{q.data.prizes.map(prizeLine)}</ul>
      )}
      <Err e={create.error ?? act.error ?? del.error} />
    </section>
  );
}

/** Completed-event archive and Hall of Fame (public results only). Hidden while history is off. */
export function ArchiveConsole({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const a = useQuery({ queryKey: ['org-archive', eventId], queryFn: () => api.archive(eventId) });
  const h = useQuery({ queryKey: ['org-hof', eventId], queryFn: () => api.hallOfFame(eventId) });
  if (!a.data?.enabled && !h.data?.enabled) return null;
  return (
    <section
      aria-labelledby="archive-ctl-title"
      className="space-y-3"
      data-testid="archive-console"
    >
      <h2 id="archive-ctl-title" className="text-xl font-semibold">
        {t('archiveCtl.title')}
      </h2>
      {a.data?.archive ? <ArchiveView archive={a.data.archive} /> : <p>{t('history.none')}</p>}
      <h3 className="font-semibold">{t('history.hof')}</h3>
      {h.data && <HallOfFameView hof={h.data} />}
    </section>
  );
}

/** Custom categories (editable until voting opens) and custom achievements (by category winner or manual award). */
export function EditorConsole({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = usePhase3Api();
  const loc = useLocalized();
  const qc = useQueryClient();
  const catKey = ['org-categories', eventId];
  const achKey = ['org-custom-ach', eventId];
  const cats = useQuery({ queryKey: catKey, queryFn: () => api.categories(eventId) });
  const achs = useQuery({ queryKey: achKey, queryFn: () => api.customAchievements(eventId) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: catKey });
    void qc.invalidateQueries({ queryKey: achKey });
  };
  const [key, setKey] = useState('c_');
  const [en, setEn] = useState('');
  const [it, setIt] = useState('');
  const addCat = useMutation({
    mutationFn: () =>
      api.createCategory(eventId, {
        key,
        name: { en: en.trim(), ...(it.trim() ? { it: it.trim() } : {}) },
      }),
    onSuccess: () => {
      setEn('');
      setIt('');
      setKey('c_');
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.updateCategory(eventId, v.id, { enabled: v.enabled }),
    onSettled: refresh,
  });
  const delCat = useMutation({
    mutationFn: (id: string) => api.deleteCategory(eventId, id),
    onSettled: refresh,
  });
  const [aKey, setAKey] = useState('c_');
  const [aName, setAName] = useState('');
  const [aDesc, setADesc] = useState('');
  const [aCat, setACat] = useState('');
  const addAch = useMutation({
    mutationFn: () =>
      api.createCustomAchievement(eventId, {
        key: aKey,
        name: { en: aName.trim() },
        description: { en: aDesc.trim() },
        ...(aCat ? { categoryKey: aCat } : {}),
      }),
    onSuccess: () => {
      setAName('');
      setADesc('');
      setAKey('c_');
      refresh();
    },
  });
  const delAch = useMutation({
    mutationFn: (id: string) => api.deleteCustomAchievement(eventId, id),
    onSettled: refresh,
  });
  const editable = cats.data?.editable ?? false;
  const keyOk = /^c_[a-z0-9_]{2,30}$/;
  return (
    <section aria-labelledby="editor-title" className="space-y-4" data-testid="editor-console">
      <h2 id="editor-title" className="text-xl font-semibold">
        {t('editor.title')}
      </h2>
      <h3 className="font-semibold">{t('editor.categories')}</h3>
      {!editable && <p>{t('editor.frozen')}</p>}
      <ul className="space-y-2">
        {cats.data?.categories.map((c) => (
          <li key={c.categoryId} className="flex flex-wrap items-center gap-2">
            <span className="grow">
              {loc(c.name)} {!c.custom && <span className="text-sm">({t('editor.builtin')})</span>}
            </span>
            <button
              type="button"
              className={`${btn} ${c.enabled ? '' : 'border-ink-900 bg-ink-900 text-white'}`}
              aria-pressed={!c.enabled}
              disabled={!editable || toggle.isPending}
              aria-label={`${c.enabled ? t('editor.disable') : t('editor.enable')}: ${loc(c.name)}`}
              onClick={() => toggle.mutate({ id: c.categoryId, enabled: !c.enabled })}
            >
              {c.enabled ? t('editor.disable') : t('editor.enable')}
            </button>
            {c.custom && (
              <button
                type="button"
                className={btn}
                disabled={!editable || delCat.isPending}
                aria-label={`${t('editor.delete')}: ${loc(c.name)}`}
                onClick={() => delCat.mutate(c.categoryId)}
              >
                {t('editor.delete')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            addCat.mutate();
          }}
        >
          <label className="block">
            {t('editor.key')}
            <input className={field} value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <label className="block">
            {t('editor.nameEn')}
            <input
              className={field}
              value={en}
              maxLength={80}
              onChange={(e) => setEn(e.target.value)}
            />
          </label>
          <label className="block">
            {t('editor.nameIt')}
            <input
              className={field}
              value={it}
              maxLength={80}
              onChange={(e) => setIt(e.target.value)}
            />
          </label>
          <button
            className={primary}
            disabled={!keyOk.test(key) || en.trim().length < 2 || addCat.isPending}
          >
            {t('editor.add')}
          </button>
        </form>
      )}
      <h3 className="font-semibold">{t('editor.achievements')}</h3>
      <ul className="space-y-2">
        {achs.data?.achievements.map((a) => (
          <li key={a.achievementId} className="flex flex-wrap items-center gap-2">
            <span className="grow">
              🏅 {loc(a.name)} — {loc(a.description)}{' '}
              {!a.categoryKey && <em>({t('editor.manual')})</em>}
            </span>
            <button
              type="button"
              className={btn}
              disabled={delAch.isPending}
              aria-label={`${t('editor.delete')}: ${loc(a.name)}`}
              onClick={() => delAch.mutate(a.achievementId)}
            >
              {t('editor.delete')}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          addAch.mutate();
        }}
      >
        <label className="block">
          {t('editor.key')}
          <input className={field} value={aKey} onChange={(e) => setAKey(e.target.value)} />
        </label>
        <label className="block">
          {t('editor.nameEn')}
          <input
            className={field}
            value={aName}
            maxLength={80}
            onChange={(e) => setAName(e.target.value)}
          />
        </label>
        <label className="block">
          {t('editor.description')}
          <input
            className={field}
            value={aDesc}
            maxLength={200}
            onChange={(e) => setADesc(e.target.value)}
          />
        </label>
        <label className="block">
          {t('editor.categoryKey')}
          <select className={field} value={aCat} onChange={(e) => setACat(e.target.value)}>
            <option value="">{t('editor.manual')}</option>
            {cats.data?.categories.map((c) => (
              <option key={c.key} value={c.key}>
                {loc(c.name)}
              </option>
            ))}
          </select>
        </label>
        <button
          className={primary}
          disabled={
            !keyOk.test(aKey) || aName.trim().length < 2 || !aDesc.trim() || addAch.isPending
          }
        >
          {t('editor.addAchievement')}
        </button>
      </form>
      <Err e={addCat.error ?? toggle.error ?? delCat.error ?? addAch.error ?? delAch.error} />
    </section>
  );
}
