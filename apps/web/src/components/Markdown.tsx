import type { ReactNode } from 'react';

/** Tiny, safe Markdown subset (headings, paragraphs, lists, tables, blockquotes, bold, code). Renders React nodes only. */
const PLACEHOLDER = /\[([^\]\n]+)\]/g;

export function inline(text: string, dev: boolean, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let n = 0;
  const plain = (s: string) => {
    let l = 0;
    let m: RegExpExecArray | null;
    PLACEHOLDER.lastIndex = 0;
    while ((m = PLACEHOLDER.exec(s))) {
      out.push(s.slice(l, m.index));
      // Draft placeholders are highlighted only in dev; production shows the plain text without brackets.
      out.push(
        dev ? (
          <mark key={`${key}p${n++}`} data-placeholder="">
            [{m[1]}]
          </mark>
        ) : (
          m[1]
        ),
      );
      l = m.index + m[0].length;
    }
    out.push(s.slice(l));
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    plain(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**'))
      out.push(
        <strong key={`${key}b${n++}`}>{inline(tok.slice(2, -2), dev, `${key}b${n}`)}</strong>,
      );
    else out.push(<code key={`${key}c${n++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  plain(text.slice(last));
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function Markdown({ source, dev }: { source: string; dev: boolean }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || /^---+$/.test(line.trim())) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1]!.length + 1, 6); // page title owns h1
      const Tag = `h${level}` as 'h2';
      blocks.push(
        <Tag key={k++} className="mt-4 text-xl font-semibold">
          {inline(h[2]!, dev)}
        </Tag>,
      );
      i++;
    } else if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!);
      const [head, , ...body] = rows;
      blocks.push(
        <div key={k++} className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {cells(head!).map((c, n) => (
                  <th key={n} scope="col" className="border-b p-2">
                    {inline(c, dev)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, n) => (
                <tr key={n}>
                  {cells(r).map((c, m) => (
                    <td key={m} className="border-b p-2 align-top">
                      {inline(c, dev)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!))
        items.push(lines[i++]!.replace(/^[-*]\s+/, ''));
      blocks.push(
        <ul key={k++} className="list-disc space-y-1 pl-5">
          {items.map((it, n) => (
            <li key={n}>{inline(it, dev)}</li>
          ))}
        </ul>,
      );
    } else if (line.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>'))
        q.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={k++} className="border-l-4 border-gold-700 pl-3" data-draft="">
          {inline(q.join(' '), dev)}
        </blockquote>,
      );
    } else {
      const p: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|\||[-*]\s|>|---)/.test(lines[i]!))
        p.push(lines[i++]!);
      blocks.push(<p key={k++}>{inline(p.join(' '), dev)}</p>);
    }
  }
  return <div className="space-y-3">{blocks}</div>;
}

/** Splits a bilingual legal doc into its preamble and per-language sections (`## English` / `## Italiano`). */
export function splitLegal(src: string): { preamble: string; en: string; it: string } {
  const text = src.replace(/\r\n/g, '\n');
  const iEn = text.search(/^## English\s*$/m);
  const iIt = text.search(/^## Italiano\s*$/m);
  const body = (from: number, to: number) =>
    text
      .slice(from, to === -1 ? undefined : to)
      .replace(/^## (English|Italiano)\s*$/m, '')
      .trim();
  if (iEn === -1 || iIt === -1) return { preamble: '', en: text, it: text };
  return {
    preamble: text.slice(0, iEn).trim(),
    en: body(iEn, iIt),
    it: body(iIt, -1),
  };
}
