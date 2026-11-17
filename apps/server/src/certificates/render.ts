import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { mulberry32 } from '@santa/domain';
import { loadCertFonts } from './fonts.js';

export const CERT_WIDTH = 1200;
export const CERT_HEIGHT = 850;

export interface CertificateInput {
  locale: 'en' | 'it';
  /** Participant display name (an achievement certificate names its owner). */
  name: string;
  title: string;
  description: string;
  eventName: string;
  year: number;
  /** Stable seed for the procedural art (same certificate = same picture). */
  seed: string;
}

const COPY = {
  en: { heading: 'CERTIFICATE OF ACHIEVEMENT', earned: 'has earned the title' },
  it: { heading: 'ATTESTATO DI MERITO', earned: 'ha ottenuto il titolo' },
} as const;

const EXTRA_FOLD: Record<string, string> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  ı: 'i',
  İ: 'I',
  Ħ: 'H',
  ħ: 'h',
};

/** Fonts are Basic Latin + Latin-1 (+ typographic punctuation): anything else is folded or replaced. */
export function latinSafe(text: string, max: number): string {
  const folded = [...text.normalize('NFC')]
    .map((ch) => {
      if (/[\u0020-\u007e\u00a1-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014\u20ac]/.test(ch))
        return ch;
      const base = EXTRA_FOLD[ch] ?? ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return /^[\u0020-\u007e]+$/.test(base) ? base : '?';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return folded.length > max ? `${folded.slice(0, max - 1).trimEnd()}…` : folded;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** Procedural art only (no files, no third-party artwork): snowflakes, golden stars and two geometric fir trees. */
export function certificateArt(seed: string): string {
  const rng = mulberry32(hash(seed));
  const flakes = Array.from({ length: 70 }, () => {
    const r = (1.5 + rng() * 5).toFixed(1);
    return `<circle cx="${(rng() * CERT_WIDTH).toFixed(0)}" cy="${(rng() * CERT_HEIGHT).toFixed(0)}" r="${r}" fill="#fff" fill-opacity="${(0.15 + rng() * 0.4).toFixed(2)}"/>`;
  });
  const star = (cx: number, cy: number, r: number, fill: string, opacity: number) => {
    const pts = Array.from({ length: 10 }, (_, i) => {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.45;
      return `${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`;
    });
    return `<polygon points="${pts.join(' ')}" fill="${fill}" fill-opacity="${opacity}"/>`;
  };
  const stars = Array.from({ length: 14 }, () =>
    star(
      rng() * CERT_WIDTH,
      rng() * CERT_HEIGHT * 0.8,
      8 + rng() * 14,
      '#fcd34d',
      0.35 + rng() * 0.4,
    ),
  );
  const tree = (x: number, base: number, scale: number) => {
    const tier = (w: number, top: number, bottom: number) =>
      `<polygon points="${x},${top} ${x - w},${bottom} ${x + w},${bottom}" fill="#166534" fill-opacity="0.85"/>`;
    return [
      `<rect x="${x - 10 * scale}" y="${base - 30 * scale}" width="${20 * scale}" height="${30 * scale}" fill="#78350f"/>`,
      tier(90 * scale, base - 250 * scale, base - 110 * scale),
      tier(70 * scale, base - 200 * scale, base - 60 * scale),
      tier(50 * scale, base - 150 * scale, base - 25 * scale),
      star(x, base - 258 * scale, 16 * scale, '#fbbf24', 1),
    ].join('');
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CERT_WIDTH}" height="${CERT_HEIGHT}" viewBox="0 0 ${CERT_WIDTH} ${CERT_HEIGHT}">${flakes.join('')}${stars.join('')}${tree(130, CERT_HEIGHT - 40, 1)}${tree(CERT_WIDTH - 130, CERT_HEIGHT - 40, 1)}</svg>`;
}

type El = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra = {}): El => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }), ...extra },
});

export function certificateElement(input: CertificateInput): El {
  const copy = COPY[input.locale];
  const art = `data:image/svg+xml;base64,${Buffer.from(certificateArt(input.seed)).toString('base64')}`;
  const name = latinSafe(input.name, 36) || '—';
  const title = latinSafe(input.title, 48);
  const description = latinSafe(input.description, 90);
  const event = latinSafe(`${input.eventName} · ${input.year}`, 70);
  const gold = '#fcd34d';
  return h(
    'div',
    {
      display: 'flex',
      position: 'relative',
      width: CERT_WIDTH,
      height: CERT_HEIGHT,
      backgroundImage: 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 45%, #14532d 100%)',
      fontFamily: 'Nunito',
    },
    [
      h('img', { position: 'absolute', top: 0, left: 0 }, undefined, {
        src: art,
        width: CERT_WIDTH,
        height: CERT_HEIGHT,
      }),
      h('div', {
        position: 'absolute',
        top: 28,
        left: 28,
        width: CERT_WIDTH - 56,
        height: CERT_HEIGHT - 56,
        border: `4px solid ${gold}`,
        borderRadius: 24,
      }),
      h(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: CERT_WIDTH,
          height: CERT_HEIGHT,
          color: '#fff',
          textAlign: 'center',
        },
        [
          h('div', { fontSize: 28, fontWeight: 700, letterSpacing: 6, color: gold }, copy.heading),
          h(
            'div',
            {
              fontSize: 88,
              fontFamily: 'Mountains of Christmas',
              fontWeight: 700,
              marginTop: 36,
              maxWidth: 980,
            },
            name,
          ),
          h('div', { fontSize: 30, marginTop: 18, opacity: 0.9 }, copy.earned),
          h(
            'div',
            {
              fontSize: 72,
              fontFamily: 'Mountains of Christmas',
              fontWeight: 700,
              color: gold,
              marginTop: 14,
              maxWidth: 980,
            },
            title,
          ),
          h('div', { fontSize: 28, marginTop: 20, maxWidth: 860, opacity: 0.95 }, description),
          h('div', { fontSize: 30, fontWeight: 700, marginTop: 56 }, event),
        ],
      ),
    ],
  );
}

/** PNG award card (1200x850). Pure function of its input + the bundled fonts. */
export async function renderCertificate(
  input: CertificateInput,
  fontsDir?: string,
): Promise<Buffer> {
  const fonts = await loadCertFonts(fontsDir);
  const svg = await satori(certificateElement(input) as never, {
    width: CERT_WIDTH,
    height: CERT_HEIGHT,
    fonts,
  });
  return new Resvg(svg, { fitTo: { mode: 'width', value: CERT_WIDTH } }).render().asPng();
}
