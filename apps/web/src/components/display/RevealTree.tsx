import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

const ornaments = [2, 3, 4, 5, 6, 7].flatMap((n, row) =>
  Array.from({ length: n }, (_, col) => ({
    x: 65 + (col - (n - 1) / 2) * 13,
    y: 29 + row * 12,
  })),
);
const colors = ['#fde68a', '#fda4af', '#a7f3d0', '#bfdbfe'];

/** Reuse the fixed slots in new colors once full; text always shows the actual event total. */
export const RevealTree = memo(function RevealTree({
  lights,
  animate,
  snapshot,
}: {
  lights: number;
  animate: boolean;
  snapshot: number;
}) {
  const { t } = useTranslation();
  const prev = useRef({ lights, snapshot });
  const baseline = prev.current.snapshot === snapshot ? prev.current.lights : lights;
  useEffect(() => {
    prev.current = { lights, snapshot };
  }, [lights, snapshot]);
  return (
    <div className="flex items-center justify-center gap-3">
      <svg aria-hidden="true" viewBox="0 0 130 106" className="h-28 w-32 shrink-0">
        <path d="M58 90h14v16H58z" fill="#d4a373" />
        <path d="M65 6 94 42H84l24 26H96l24 25H10l24-25H22l24-26H36z" fill="#22805b" />
        <path d="m65 1 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="#fde68a" />
        {ornaments.map(({ x, y }, slot) => {
          const first = slot + 1;
          const turn = Math.floor((lights - first) / ornaments.length);
          const serial = first + turn * ornaments.length;
          const lit = turn >= 0;
          return (
            <circle
              key={lit ? serial : `unlit-${slot}`}
              cx={x}
              cy={y}
              r={lit ? 3.25 : 2}
              fill={lit ? colors[(turn + slot) % colors.length] : '#153d31'}
              className={animate && lit && serial > baseline ? 'reveal-ornament-on' : undefined}
            />
          );
        })}
      </svg>
      <div className="text-left">
        <p className="font-semibold">{t('revealShow.tree')}</p>
        <p role="status" data-testid="reveal-tree-count" className="tabular-nums text-gold-400">
          {t('revealShow.lights', { count: lights })}
        </p>
      </div>
    </div>
  );
});
