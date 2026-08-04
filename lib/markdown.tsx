// Minimal markdown → React renderer for agent replies. Replaces react-markdown +
// remark-gfm: the unified/remark stack was ~144KB of the content-script bundle,
// which WXT ships as a single IIFE with no code splitting. Output is React
// elements only — never innerHTML — so network-sourced text is escaped by React
// by construction (same safety level as react-markdown without rehypeRaw).
//
// Scope: what LLM replies actually contain. Anything unclosed/malformed degrades
// to plain text instead of swallowing the rest of the reply.
import type { ReactElement, ReactNode } from 'react';

type List = { ordered: boolean; items: { text: string; sub: List | null }[]; next: number };

const isFenceOpen = (l: string) => /^ {0,3}```/.test(l);
const isFenceClose = (l: string) => /^ {0,3}```[ \t]*$/.test(l);
const HEADING_RE = /^ {0,3}(#{1,4})[ \t]+(\S.*)$/;
const HR_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?/;

function matchListItem(line: string) {
  const m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/);
  if (!m) return null;
  return { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] };
}

// "| a | b |" → ["a", "b"]; escaped pipes inside cells are not special-cased
// (LLM tables rarely escape, and a stray split cell just looks slightly off)
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// GFM delimiter row: cells of only - and : like | --- | :---: |
function delimiterCells(line: string): number | null {
  if (!line.includes('-')) return null;
  const cells = splitRow(line);
  return cells.every((c) => /^:?-+:?$/.test(c)) ? cells.length : null;
}

// A line that must interrupt a paragraph: a real block opener. Tables need a
// matching delimiter row, fences need a closer — otherwise they stay plain text.
function isBlockStart(lines: string[], j: number): boolean {
  const l = lines[j];
  if (isFenceOpen(l)) return lines.slice(j + 1).some(isFenceClose);
  if (HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l)) return true;
  if (matchListItem(l)) return true;
  if (l.includes('|') && j + 1 < lines.length) {
    const cols = delimiterCells(lines[j + 1]);
    if (cols !== null && cols === splitRow(l).length) return true;
  }
  return false;
}

// Indentation-based nesting: a deeper-indent item attaches to the previous item;
// a shallower one (or a ul/ol type switch at the same depth) closes the list.
function parseList(lines: string[], start: number): List {
  const first = matchListItem(lines[start])!;
  const base = first.indent;
  const items: List['items'] = [];
  let i = start;
  while (i < lines.length) {
    const m = matchListItem(lines[i]);
    if (!m || m.indent < base || (m.indent === base && m.ordered !== first.ordered)) break;
    if (m.indent > base) {
      // a list can't open with a nested item; treat the stray indent as the end
      if (items.length === 0) break;
      const sub = parseList(lines, i);
      items[items.length - 1].sub = sub;
      i = sub.next;
      continue;
    }
    items.push({ text: m.text, sub: null });
    i++;
  }
  return { ordered: first.ordered, items, next: i };
}

// Inline grammar, one regex pass. Priority left → right: code spans can't hold
// markup; bold before italic so ** doesn't parse as two *; content must start
// non-space so "2 * 3 * 4" stays text. No match → literal text, which is exactly
// how unclosed ** or ~~ degrade without eating characters.
const INLINE_RE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(\S[^*]*?)\*\*|~~(\S[^~]*?)~~|\*(\S[^*\n]*?)\*/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<code key={key++}>{m[1]}</code>);
    } else if (m[2] !== undefined) {
      // http/https only: javascript:/data: URLs render as plain link text with
      // no anchor at all, so there is nothing clickable to exploit
      if (/^https?:\/\//i.test(m[3])) {
        out.push(
          <a key={key++} href={m[3]} target="_blank" rel="noopener noreferrer">
            {m[2]}
          </a>,
        );
      } else {
        out.push(m[2]);
      }
    } else if (m[4] !== undefined) {
      out.push(<strong key={key++}>{m[4]}</strong>);
    } else if (m[5] !== undefined) {
      out.push(<del key={key++}>{m[5]}</del>);
    } else {
      out.push(<em key={key++}>{m[6]}</em>);
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderList(list: List, key: number): ReactElement {
  const Tag = list.ordered ? 'ol' : 'ul';
  return (
    <Tag key={key}>
      {list.items.map((item, i) => (
        <li key={i}>
          {renderInline(item.text)}
          {item.sub && renderList(item.sub, i)}
        </li>
      ))}
    </Tag>
  );
}

function renderBlocks(md: string): ReactNode[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const n = lines.length;
  let i = 0;

  while (i < n) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }

    // fenced code; language hint is intentionally ignored (no highlighter).
    // An opener without a closer degrades the remainder to a plain-text
    // paragraph instead of eating it as fake code.
    if (isFenceOpen(lines[i])) {
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j])) j++;
      if (j < n) {
        blocks.push(
          <pre key={blocks.length}>
            <code>{lines.slice(i + 1, j).join('\n')}</code>
          </pre>,
        );
        i = j + 1;
        continue;
      }
      blocks.push(
        <p key={blocks.length} className="whitespace-pre-wrap">
          {lines.slice(i).join('\n')}
        </p>,
      );
      break;
    }

    const h = lines[i].match(HEADING_RE);
    if (h) {
      const Tag = `h${h[1].length}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={blocks.length}>{renderInline(h[2].trim())}</Tag>);
      i++;
      continue;
    }

    if (HR_RE.test(lines[i])) {
      blocks.push(<hr key={blocks.length} />);
      i++;
      continue;
    }

    if (QUOTE_RE.test(lines[i])) {
      const inner: string[] = [];
      let j = i;
      while (j < n && QUOTE_RE.test(lines[j])) {
        inner.push(lines[j].replace(QUOTE_RE, ''));
        j++;
      }
      // quote body is full markdown again (nested quotes, lists, ...)
      blocks.push(<blockquote key={blocks.length}>{renderBlocks(inner.join('\n'))}</blockquote>);
      i = j;
      continue;
    }

    // GFM pipe table: header row whose column count matches a delimiter row
    if (lines[i].includes('|') && i + 1 < n) {
      const head = splitRow(lines[i]);
      const cols = delimiterCells(lines[i + 1]);
      if (cols !== null && cols === head.length) {
        const rows: string[][] = [];
        let j = i + 2;
        while (j < n && lines[j].trim() && lines[j].includes('|')) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        blocks.push(
          <table key={blocks.length}>
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci}>{renderInline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, ci) => (
                    // short/extra cells are padded/dropped to the header width
                    <td key={ci}>{renderInline(r[ci] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        i = j;
        continue;
      }
    }

    if (matchListItem(lines[i])) {
      const list = parseList(lines, i);
      blocks.push(renderList(list, blocks.length));
      i = list.next;
      continue;
    }

    // paragraph: run of lines up to the next blank line or block opener
    let j = i + 1;
    while (j < n && lines[j].trim() && !isBlockStart(lines, j)) j++;
    blocks.push(<p key={blocks.length}>{renderInline(lines.slice(i, j).join('\n'))}</p>);
    i = j;
  }

  return blocks;
}

/** Render an agent reply as markdown. Any parser edge case that throws falls back to the raw text — a garbled reply must still be readable. */
export function Markdown({ text }: { text: string }) {
  try {
    return <>{renderBlocks(text)}</>;
  } catch {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }
}
