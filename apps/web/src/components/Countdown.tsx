import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Server-clock countdown (`now` should be the realtime store's serverNow). Plain timer role: not announced every second. */
export function Countdown({
  endsAt,
  now,
  className = '',
}: {
  endsAt: string;
  now: () => number;
  className?: string;
}) {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(endsAt) - now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <p
      role="timer"
      aria-label={t('display.countdown')}
      className={`font-extrabold leading-none tabular-nums ${className}`}
    >
      {mm}:{ss}
    </p>
  );
}
