import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Phase } from '@santa/contracts';
import { PhaseStepper } from './PhaseStepper';

export interface ConsoleHeaderProps {
  name: string;
  phase: Phase;
  paused: boolean;
  /** Full display URL (/d…) once a display link was created this session; tokens are shown once. */
  displayUrl?: string | undefined;
  /** Where to go to create a display link when none is known (People tab). */
  displaySetupHref: string;
  /**
   * Autopilot status chip slot. When omitted a neutral "Manual" chip is shown.
   * The autopilot todo plugs `<AutopilotChip …/>` in here from Console.tsx.
   */
  autopilotChip?: ReactNode | undefined;
  /** Rendered first inside the sticky header (e.g. the unmask banner). */
  banner?: ReactNode | undefined;
}

const chip = 'inline-flex min-h-8 items-center rounded-full px-3 text-sm font-semibold';

/** Sticky cockpit header: event name, phase stepper, freeze badge, autopilot chip, display link. */
export function ConsoleHeader(p: ConsoleHeaderProps) {
  const { t } = useTranslation();
  return (
    <header
      data-testid="console-header"
      className="sticky top-0 z-30 -mx-4 space-y-2 border-b border-ink-900/20 bg-snow-50 px-4 py-2"
    >
      {p.banner}
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/o" className="underline">
          {t('console.back')}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-bold">{p.name}</h1>
        {p.paused && (
          <span
            role="status"
            data-testid="freeze-badge"
            className={`${chip} bg-gold-400 text-ink-900`}
          >
            {t('console.paused')}
          </span>
        )}
        <span data-testid="autopilot-chip-slot">
          {p.autopilotChip ?? (
            <span className={`${chip} border border-ink-900 text-ink-900`}>
              {t('console.autopilot.manual')}
            </span>
          )}
        </span>
      </div>
      <p className="sr-only">
        {t('console.currentPhase')}: {t(`phase.${p.phase}`)}
      </p>
      <PhaseStepper phase={p.phase} />
      <DisplayLink url={p.displayUrl} setupHref={p.displaySetupHref} />
    </header>
  );
}

function DisplayLink({ url, setupHref }: { url?: string | undefined; setupHref: string }) {
  const { t } = useTranslation();
  const [msg, setMsg] = useState('');
  if (!url)
    return (
      <p className="text-sm">
        <Link to={setupHref} className="underline">
          {t('console.display.setup')}
        </Link>
      </p>
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setMsg(t('console.display.copied'));
    } catch {
      setMsg(t('console.display.copyFailed'));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="header-display-link">
      <span>{t('console.display.label')}:</span>
      <a href={url} target="_blank" rel="noreferrer" className="max-w-full truncate underline">
        {url}
      </a>
      <button
        type="button"
        className="min-h-11 rounded border border-ink-900 px-3 font-semibold"
        onClick={() => void copy()}
      >
        {t('console.display.copy')}
      </button>
      <span role="status" aria-live="polite">
        {msg}
      </span>
    </div>
  );
}
