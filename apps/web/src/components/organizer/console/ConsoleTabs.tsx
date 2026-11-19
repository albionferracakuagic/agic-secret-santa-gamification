import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CONSOLE_TABS, panelId, tabId, type ConsoleTab } from './types';

/**
 * WAI-ARIA tabs (automatic activation): ←/→ move + select, Home/End jump; roving tabindex.
 * Only the active panel is mounted so inactive tabs fire no queries.
 */
export function ConsoleTabs({
  active,
  onChange,
  children,
}: {
  active: ConsoleTab;
  onChange: (t: ConsoleTab) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const refs = useRef<Partial<Record<ConsoleTab, HTMLButtonElement | null>>>({});
  const move = (to: ConsoleTab) => {
    onChange(to);
    refs.current[to]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = CONSOLE_TABS.indexOf(active);
    const n = CONSOLE_TABS.length;
    const to =
      e.key === 'ArrowRight'
        ? CONSOLE_TABS[(i + 1) % n]
        : e.key === 'ArrowLeft'
          ? CONSOLE_TABS[(i - 1 + n) % n]
          : e.key === 'Home'
            ? CONSOLE_TABS[0]
            : e.key === 'End'
              ? CONSOLE_TABS[n - 1]
              : undefined;
    if (!to) return;
    e.preventDefault();
    move(to);
  };
  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={t('console.tabs.label')}
        onKeyDown={onKey}
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-ink-900/20 px-4"
      >
        {CONSOLE_TABS.map((k) => {
          const sel = k === active;
          return (
            <button
              key={k}
              ref={(el) => {
                refs.current[k] = el;
              }}
              type="button"
              role="tab"
              id={tabId(k)}
              aria-selected={sel}
              aria-controls={sel ? panelId(k) : undefined /* only the active panel exists */}
              tabIndex={sel ? 0 : -1}
              onClick={() => onChange(k)}
              className={`min-h-12 shrink-0 whitespace-nowrap border-b-4 px-4 font-semibold ${
                sel ? 'border-santa-600 text-ink-900' : 'border-transparent text-ink-900'
              }`}
            >
              {t(`console.tabs.${k}`)}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(active)}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className="space-y-6 outline-none"
      >
        {children}
      </div>
    </div>
  );
}
