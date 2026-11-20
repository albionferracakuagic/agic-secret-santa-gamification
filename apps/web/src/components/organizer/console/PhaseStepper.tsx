import { useTranslation } from 'react-i18next';
import { PHASES, type Phase } from '@santa/contracts';

/** Read-only progress of the 9 event phases: past = done, current = highlighted (aria-current="step"). */
export function PhaseStepper({ phase }: { phase: Phase }) {
  const { t } = useTranslation();
  const cur = PHASES.indexOf(phase);
  return (
    <nav
      aria-label={t('console.stepper.label')}
      tabIndex={0} /* scrollable on small screens: keyboard-reachable */
      className="-mx-1 overflow-x-auto pb-1"
    >
      <ol className="flex min-w-max items-center gap-1 px-1 text-xs sm:text-sm">
        {PHASES.map((p, i) => {
          const state = i < cur ? 'done' : i === cur ? 'current' : 'todo';
          const cls =
            state === 'current'
              ? 'bg-santa-600 font-bold text-white'
              : state === 'done'
                ? 'bg-pine-900 text-white'
                : 'border border-ink-900 text-ink-900';
          return (
            <li
              key={p}
              data-testid={`step-${p}`}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex items-center gap-1 rounded-full px-2 py-1 ${cls}`}
            >
              <span aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
              <span>{t(`phase.${p}`)}</span>
              {state !== 'todo' && (
                <span className="sr-only">
                  ({t(state === 'done' ? 'console.stepper.done' : 'console.stepper.current')})
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
