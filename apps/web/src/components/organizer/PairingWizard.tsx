import { useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAIRING_FIELDS, type PairingField, type PairingMapping } from '@santa/contracts';
import { useOrganizerApi, type PairingImportResult, type PairingLatest } from '../../api/organizer';
import { errorKey } from '../../pages/Dashboard';

type Issue = PairingImportResult['issues'][number];
type Summary = NonNullable<PairingImportResult['summary']>;
type Mapping = { [K in PairingField]?: string | undefined };

const hasBothSides = (m: Mapping) =>
  !!(m.giverName || m.giverEmail) && !!(m.recipientName || m.recipientEmail);

/** Upload -> sheet pick -> column mapping (EN/IT header suggestions from the server) -> masked issue list. Never shows pairs. */
export function PairingWizard({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const api = useOrganizerApi();
  const qc = useQueryClient();
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<PairingImportResult>();
  const [sheet, setSheet] = useState<string>();
  const [mapping, setMapping] = useState<Mapping>({});
  const [editMapping, setEditMapping] = useState(false);

  const latest = useQuery({
    queryKey: ['pairing-latest', eventId],
    queryFn: () => api.latestPairing(eventId),
  });
  const upload = useMutation({
    mutationFn: (o: {
      file: File;
      sheet?: string | undefined;
      mapping?: PairingMapping | undefined;
    }) => api.uploadPairing(eventId, o.file, { sheet: o.sheet, mapping: o.mapping }),
    onSuccess: (r) => {
      setResult(r);
      setSheet(r.sheet ?? undefined);
      setMapping({ ...r.suggestedMapping, ...(r.mapping ?? {}) });
      setEditMapping(r.status === 'needs_mapping');
      void qc.invalidateQueries({ queryKey: ['pairing-latest', eventId] });
    },
  });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(undefined);
    upload.mutate({ file: f });
  };
  const applyMapping = () => {
    if (!file || !hasBothSides(mapping)) return;
    upload.mutate({ file, sheet, mapping: mapping as PairingMapping });
  };
  const reimportBlocked = latest.data?.reimportAllowed === false;

  const shown: { status: 'draft' | 'ready'; summary: Summary | null; issues: Issue[] } | undefined =
    result && result.status !== 'needs_mapping'
      ? { status: result.status, summary: result.summary, issues: result.issues }
      : latestShown(latest.data);

  return (
    <section aria-labelledby="pairing-title" className="space-y-3">
      <h2 id="pairing-title" className="text-xl font-semibold">
        {t('pairing.title')}
      </h2>
      <p className="text-sm">{t('pairing.privacy')}</p>
      {reimportBlocked ? (
        <p role="status">{t('pairing.locked')}</p>
      ) : (
        <label className="block font-semibold text-ink-900">
          {t('pairing.file')}
          <input
            type="file"
            accept=".csv,.xlsx,text/csv"
            className="pairing-file-input mt-1 block min-h-12 w-full"
            onChange={onFile}
          />
        </label>
      )}
      {upload.isPending && <p role="status">{t('a11y.loading')}</p>}
      {upload.isError && (
        <p role="alert" className="rounded bg-santa-700 p-3 text-white">
          {t(errorKey(upload.error))}
        </p>
      )}

      {result && result.sheets.length > 1 && (
        <label className="block">
          {t('pairing.sheet')}
          <select
            className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-2"
            value={sheet ?? ''}
            onChange={(e) => {
              setSheet(e.target.value);
              if (file) upload.mutate({ file, sheet: e.target.value });
            }}
          >
            {result.sheets.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      )}

      {result && editMapping && (
        <fieldset className="space-y-2 rounded border border-ink-900/30 p-3">
          <legend className="font-semibold">{t('pairing.mapping')}</legend>
          <p className="text-sm">{t('pairing.mappingHint')}</p>
          {PAIRING_FIELDS.map((f) => (
            <label key={f} className="block">
              {t(`pairing.field.${f}`)}
              <select
                className="mt-1 block min-h-12 w-full rounded border border-ink-900/40 bg-white px-2"
                value={mapping[f] ?? ''}
                onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value || undefined }))}
              >
                <option value="">{t('pairing.none')}</option>
                {result.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!hasBothSides(mapping) && <p role="status">{t('pairing.needBoth')}</p>}
          <button
            type="button"
            className="min-h-12 rounded bg-pine-900 px-4 font-semibold text-white disabled:opacity-50"
            disabled={!hasBothSides(mapping) || upload.isPending}
            onClick={applyMapping}
          >
            {t('pairing.apply')}
          </button>
        </fieldset>
      )}
      {result && !editMapping && result.status !== 'needs_mapping' && (
        <button
          type="button"
          className="min-h-12 rounded border border-ink-900 px-4"
          onClick={() => setEditMapping(true)}
        >
          {t('pairing.changeMapping')}
        </button>
      )}

      {shown && <ImportStatus {...shown} />}
    </section>
  );
}

function latestShown(l: PairingLatest | undefined) {
  const i = l?.import;
  return i ? { status: i.status, summary: i.summary as Summary, issues: i.issues } : undefined;
}

function ImportStatus({
  status,
  summary,
  issues,
}: {
  status: 'draft' | 'ready';
  summary: Summary | null;
  issues: Issue[];
}) {
  const { t } = useTranslation();
  const label = (i: Issue) => t(`pairing.issue.${i.code}`, { count: i.count ?? 0 });
  return (
    <div className="space-y-2" data-testid="pairing-status">
      <p role="status" className="font-semibold">
        {t(`pairing.status.${status}`)}
      </p>
      {summary && (
        <p>
          {t('pairing.summary', {
            rows: summary.rows,
            matched: summary.matchedRoster,
            added: summary.newRosterEntries,
            errors: summary.errors,
            warnings: summary.warnings,
          })}
        </p>
      )}
      {issues.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {issues.map((i, n) => (
            <li key={n} className={i.severity === 'error' ? 'font-semibold' : ''}>
              {t(`pairing.severity.${i.severity}`)}:{' '}
              {i.row === null ? label(i) : t('pairing.row', { row: i.row, issue: label(i) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
