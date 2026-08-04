import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Markdown } from '@/lib/markdown';

// lib/markdown replaces react-markdown + remark-gfm (~144KB in the content
// script); these tests pin both the supported structures and the safety
// properties (no HTML injection, no non-http links) that replacement must keep
afterEach(cleanup);

const md = (text: string) => render(<Markdown text={text} />);

describe('Markdown block structures', () => {
  it('renders h1–h4 headings', () => {
    md('# H1\n## H2\n### H3\n#### H4');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('H1');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('H2');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('H3');
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('H4');
  });

  it('renders paragraphs, joining soft line breaks', () => {
    const { container } = md('first line\nsecond line');
    expect(container.querySelectorAll('p')).toHaveLength(1);
    // toHaveTextContent normalizes whitespace: the \n shows up as a space
    expect(container.querySelector('p')).toHaveTextContent('first line second line');
  });

  it('renders fenced code blocks and ignores the language hint', () => {
    const { container } = md('```ts\nconst x = 1 < 2;\n```');
    const code = container.querySelector('pre code');
    expect(code).toHaveTextContent('const x = 1 < 2;');
    // code content is raw text, not parsed as inline markdown or HTML
    expect(container.querySelector('pre b')).toBeNull();
  });

  it('renders unordered and ordered lists', () => {
    const { container } = md('- a\n- b\n\n1. one\n2. two');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('nests lists by indentation', () => {
    const { container } = md('- a\n- b\n  - b1\n  - b2\n- c');
    const top = container.querySelectorAll(':scope > ul > li');
    expect(top).toHaveLength(3);
    const nested = top[1].querySelectorAll('ul li');
    expect(nested).toHaveLength(2);
    expect(nested[0]).toHaveTextContent('b1');
  });

  it('renders blockquotes with markdown inside', () => {
    const { container } = md('> quoted **text**');
    const quote = container.querySelector('blockquote');
    expect(quote).toHaveTextContent('quoted text');
    expect(quote?.querySelector('strong')).toHaveTextContent('text');
  });

  it('renders a horizontal rule', () => {
    const { container } = md('above\n\n---\n\nbelow');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders GFM pipe tables', () => {
    md('| name | age |\n| --- | --- |\n| ann | 3 |\n| bob | 5 |');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['name', 'age']);
    expect(screen.getByRole('cell', { name: 'bob' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('does not turn a pipe-less line followed by --- into a table', () => {
    const { container } = md('just text\n\n---');
    expect(container.querySelector('table')).toBeNull();
  });
});

describe('Markdown inline structures', () => {
  it('renders bold, italic and strikethrough', () => {
    const { container } = md('**b** *i* ~~s~~');
    expect(container.querySelector('strong')).toHaveTextContent('b');
    expect(container.querySelector('em')).toHaveTextContent('i');
    expect(container.querySelector('del')).toHaveTextContent('s');
  });

  it('renders inline code without parsing its content', () => {
    const { container } = md('run `npm **test**` now');
    expect(container.querySelector('code')).toHaveTextContent('npm **test**');
    expect(container.querySelector('code strong')).toBeNull();
  });

  it('renders http/https links with safe target and rel', () => {
    md('see [docs](https://example.com/x) and [http too](http://e.com)');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/x');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps inline formatting working inside headings, list items and table cells', () => {
    const { container } = md('## a **b**\n\n- x `y`\n\n| h |\n| --- |\n| *i* |');
    expect(container.querySelector('h2 strong')).toHaveTextContent('b');
    expect(container.querySelector('li code')).toHaveTextContent('y');
    expect(container.querySelector('td em')).toHaveTextContent('i');
  });
});

describe('Markdown safety and degradation', () => {
  it('does not produce an href for javascript: links', () => {
    const { container } = md('[click me](javascript:alert(1))');
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    // the link text survives as plain text
    expect(container).toHaveTextContent('click me');
  });

  it('escapes raw HTML instead of interpreting it', () => {
    const { container } = md('look <script>alert(1)</script> here');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
  });

  it('does not swallow text on an unclosed **', () => {
    const { container } = md('hello **world');
    expect(container.querySelector('strong')).toBeNull();
    expect(container).toHaveTextContent('hello **world');
  });

  it('does not swallow text on an unclosed inline code span', () => {
    const { container } = md('hello `code');
    expect(container.querySelector('code')).toBeNull();
    expect(container).toHaveTextContent('hello `code');
  });

  it('degrades an unclosed code fence to plain text', () => {
    const { container } = md('```js\nconst x = 1;');
    expect(container.querySelector('pre')).toBeNull();
    expect(container).toHaveTextContent('```js');
    expect(container).toHaveTextContent('const x = 1;');
  });

  it('degrades a table whose delimiter row does not match', () => {
    const { container } = md('| a | b |\n| not-a-delimiter |');
    expect(container.querySelector('table')).toBeNull();
    expect(container).toHaveTextContent('| a | b |');
  });
});
