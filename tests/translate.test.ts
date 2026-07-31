import { describe, expect, it } from 'vitest';
import { scanUnits, inject } from '@/lib/translate';

describe('scanUnits', () => {
  it('picks deepest text blocks and honors skip rules', () => {
    document.body.innerHTML = `
      <article>
        <p>Hello world paragraph</p>
        <pre><code>const x = 1</code></pre>
        <div class="notranslate">skip me</div>
        <div translate="no">skip me too</div>
        <div><p>nested wins</p></div>
        <div>7</div>
      </article>`;
    const texts = scanUnits(document.body).map((el) => el.textContent?.trim());
    // code/notranslate/translate=no 被跳过；嵌套时最深块胜出；纯数字太短被过滤
    expect(texts).toEqual(['Hello world paragraph', 'nested wins']);
  });
  it('drills into nav containers with multiple links instead of lumping them', () => {
    document.body.innerHTML = `
      <nav>
        <a href="#">Introduction</a>
        <a href="#">Installation</a>
        <a href="#">Changelog</a>
      </nav>`;
    const texts = scanUnits(document.body).map((el) => el.textContent?.trim());
    // 容器无直接文本且含多链接 → 逐项作为翻译单元，译文行内跟在各条目后
    expect(texts).toEqual(['Introduction', 'Installation', 'Changelog']);
  });
});

describe('inject', () => {
  it('appends a sibling translation node without touching original text nodes', () => {
    document.body.innerHTML = '<p>This paragraph is long enough to render as a block.</p>';
    const p = document.querySelector('p')!;
    const originalTextNode = p.firstChild!;
    inject(p, '这段话足够长，按块级换行渲染。');

    const node = p.querySelector('pixel-agent-translation')!;
    expect(node).not.toBeNull();
    expect(node.className).toBe('notranslate'); // 译文自身不可再被扫描翻译
    expect(node.textContent).toBe('这段话足够长，按块级换行渲染。');
    expect((node as HTMLElement).style.display).toBe('block'); // 长文本走块级
    expect(p.firstChild).toBe(originalTextNode); // 原文文本节点未被移动/替换

    // 注入后的段落不会被再次收集（防重翻循环）
    expect(scanUnits(node)).toEqual([]);
  });

  it('renders short/nav-context text inline', () => {
    document.body.innerHTML = '<ul><li>File</li></ul>';
    const li = document.querySelector('li')!;
    inject(li, '文件');
    const node = li.querySelector('pixel-agent-translation') as HTMLElement;
    expect(node.style.display).toBe('inline-block'); // 短译文行内续排，整体不折行
    expect(node.style.whiteSpace).toBe('nowrap');
  });
});
