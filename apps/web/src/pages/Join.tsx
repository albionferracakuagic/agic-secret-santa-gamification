import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useParticipantApi, type JoinResolve, type JoinTarget } from '../api/participant';

type Step =
  | { kind: 'code' }
  | { kind: 'roster'; target: JoinTarget; info: JoinResolve }
  | { kind: 'pending'; target: JoinTarget };

const btn =
  'min-h-12 rounded bg-santa-600 px-4 font-semibold text-white hover:bg-santa-700 disabled:opacity-60';
const field = 'mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-3';

const errorKey = (e: unknown) =>
  e instanceof ApiError && ['invalid_claim', 'rate_limited', 'name_taken'].includes(e.code)
    ? `join.error.${e.code}`
    : 'join.error.generic';

/** /j[/:token] | /j?code=SHORT | /j/claim?token=… — enter code or QR landing -> pick name -> pending/approved. */
export default function Join() {
  const { t } = useTranslation();
  const api = useParticipantApi();
  const nav = useNavigate();
  const tail = useParams()['*']?.split('/')[0];
  const [params] = useSearchParams();
  const claimToken = tail === 'claim' ? (params.get('token') ?? undefined) : undefined;
  const joinToken = tail && tail !== 'claim' ? tail : undefined;
  const presetCode = params.get('code')?.toUpperCase() ?? undefined;
  const [step, setStep] = useState<Step>({ kind: 'code' });
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(errorKey(e));
    } finally {
      setBusy(false);
    }
  };

  const lookup = (target: JoinTarget) =>
    run(async () => setStep({ kind: 'roster', target, info: await api.resolve(target) }));

  useEffect(() => {
    if (claimToken) {
      void run(async () => {
        await api.claim({ method: 'email_link', token: claimToken });
        nav('/e', { replace: true });
      });
    } else if (joinToken) void lookup({ joinToken });
    else if (presetCode) void lookup({ shortCode: presetCode });
  }, [claimToken, joinToken, presetCode]);

  const pick = (target: JoinTarget, participantId: string) =>
    run(async () => {
      const r = await api.claim({ method: 'pick_name', target, participantId });
      if (r.status === 'active') nav('/e');
      else setStep({ kind: 'pending', target });
    });

  return (
    <section aria-labelledby="join-title" className="space-y-4">
      <h1 id="join-title" className="text-2xl font-bold">
        {t('route.join')}
      </h1>
      {err && (
        <p role="alert" className="rounded border border-santa-600 p-3">
          {t(err)}
        </p>
      )}
      {step.kind === 'code' && (
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void lookup({ shortCode: code.trim().toUpperCase() });
          }}
        >
          <label className="block">
            {t('join.codeLabel')}
            <input
              className={field}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={8}
            />
          </label>
          <p className="text-sm">{t('join.codeHint')}</p>
          <button className={btn} disabled={busy || code.trim().length < 6}>
            {t('join.continue')}
          </button>
        </form>
      )}
      {step.kind === 'roster' && (
        <RosterPick info={step.info} busy={busy} onPick={(id) => pick(step.target, id)} />
      )}
      {step.kind === 'pending' && <Pending target={step.target} />}
    </section>
  );
}

function RosterPick({
  info,
  onPick,
  busy,
}: {
  info: JoinResolve;
  onPick: (participantId: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const list = info.unclaimed.filter((r) => r.displayName.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-3">
      <p className="text-lg">{t('join.welcome', { event: info.event.name })}</p>
      {!info.event.joinOpen && <p role="status">{t('join.notOpen')}</p>}
      <label className="block">
        {t('join.search')}
        <input className={field} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <h2 className="font-semibold">{t('join.pickTitle')}</h2>
      {list.length === 0 ? (
        <p>{t('join.noMatch')}</p>
      ) : (
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.participantId}>
              <button
                type="button"
                className="flex min-h-12 w-full items-center gap-3 rounded border border-ink-900/30 bg-white px-3 text-left disabled:opacity-60"
                disabled={!info.event.joinOpen || busy}
                onClick={() => onPick(r.participantId)}
              >
                <span aria-hidden="true">🎅</span>
                <span>{r.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Waits for approval (polls own status) and offers the verified-claim code. */
function Pending({ target }: { target: JoinTarget }) {
  const { t } = useTranslation();
  const api = useParticipantApi();
  const [approved, setApproved] = useState(false);
  const [personal, setPersonal] = useState('');
  const [err, setErr] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      void api
        .me()
        .then((m) => m.status === 'active' && setApproved(true))
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(id);
  }, [api]);

  if (approved) return <Navigate to="/e" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(false);
    try {
      await api.claim({ method: 'personal_code', target, code: personal.trim().toUpperCase() });
      setApproved(true);
    } catch {
      setErr(true);
    }
  };

  return (
    <div className="space-y-4">
      <p role="status" className="text-lg">
        {t('join.pending')}
      </p>
      <h2 className="font-semibold">{t('join.claimTitle')}</h2>
      <p>{t('join.claimEmail')}</p>
      <p>{t('join.claimInPerson')}</p>
      <form onSubmit={submit} className="space-y-2">
        <label className="block">
          {t('join.claimCode')}
          <input
            className={field}
            value={personal}
            onChange={(e) => setPersonal(e.target.value)}
            autoComplete="off"
            maxLength={12}
          />
        </label>
        {err && <p role="alert">{t('join.error.claim')}</p>}
        <button className={btn} disabled={personal.trim().length < 8}>
          {t('join.claimSubmit')}
        </button>
      </form>
    </div>
  );
}
