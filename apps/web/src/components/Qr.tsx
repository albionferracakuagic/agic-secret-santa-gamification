import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** Locally generated QR (no third-party service sees the join link). */
export function Qr({ value, label }: { value: string; label: string }) {
  const rows = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    return { n, dark: Array.from({ length: n * n }, (_, i) => q.isDark(Math.floor(i / n), i % n)) };
  }, [value]);
  const m = 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-m} ${-m} ${rows.n + 2 * m} ${rows.n + 2 * m}`}
      className="h-full w-full bg-white"
      shapeRendering="crispEdges"
    >
      {rows.dark.map((d, i) =>
        d ? <rect key={i} x={i % rows.n} y={Math.floor(i / rows.n)} width="1" height="1" /> : null,
      )}
    </svg>
  );
}
