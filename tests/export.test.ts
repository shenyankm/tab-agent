import { describe, it, expect } from 'vitest';
import { renderTemplate, clipsToMarkdown } from '@/lib/export';
import type { Clip } from '@/lib/clips';

const clip: Clip = {
  id: 'a',
  url: 'https://e.com/p#:~:text=hi',
  pageUrl: 'https://e.com/p',
  title: 'My Title',
  text: 'hi',
  createdAt: 1767225600000, // 2026-01-01
  kind: 'page',
  fullText: 'the whole article',
  tags: ['ai', 'web'],
  notes: ['note one'],
  category: 'concept',
  author: 'Ann',
  published: '2025-12-31',
};

describe('renderTemplate', () => {
  it('substitutes known variables', () => {
    const out = renderTemplate('t={{title}} u={{url}} c={{category}} g={{tags}} n={{notes}} d={{createdAt}} b={{fullText}}', clip);
    expect(out).toBe('t=My Title u=https://e.com/p c=concept g=ai, web n=note one d=2026-01-01 b=the whole article');
  });

  it('missing values render empty, unknown tokens stay intact', () => {
    const bare: Clip = { id: 'b', url: 'u', pageUrl: 'u', title: 'T', text: 'x', createdAt: 0 };
    expect(renderTemplate('[{{author}}][{{nope}}]', bare)).toBe('[][{{nope}}]');
  });

  it('flattens newlines in frontmatter-style values but keeps body fields intact', () => {
    const multi: Clip = { ...clip, title: 'line1\nline2', fullText: 'a\n\nb' };
    expect(renderTemplate('{{title}}|{{fullText}}', multi)).toBe('line1 line2|a\n\nb');
  });
});

describe('clipsToMarkdown', () => {
  it('joins rendered clips with a markdown rule', () => {
    expect(clipsToMarkdown([clip, clip], '{{title}}')).toBe('My Title\n\n---\n\nMy Title');
  });
});
