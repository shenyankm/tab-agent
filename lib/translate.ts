// 整页双语对照：扫描最深文本块 → 视口懒翻译 → 追加兄弟节点。
// 全程只 append、不包裹/替换原文节点 —— 规避 React 宿主页 removeChild 崩溃类问题。

const APP_TAG = 'pixel-agent-translation';

// 行业共识跳过规则（notranslate / translate=no / 可编辑区 / 代码等）+ 本扩展自身 UI
const SKIP_SELECTOR = [
  'script', 'style', 'code', 'pre', 'kbd', 'textarea', 'input', 'select', 'svg', 'math',
  'noscript', 'iframe', '[contenteditable="true"]', '[translate="no"]', '.notranslate',
  APP_TAG, 'pixel-agent-floating-ui',
].join(',');

const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'DATA', 'DFN', 'EM', 'I', 'LABEL', 'MARK',
  'Q', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'BR', 'FONT', 'IMG',
]);

// 块判定：静态表优先，getComputedStyle 回退，WeakMap 摊薄强制 layout 成本
const blockCache = new WeakMap<Element, boolean>();
function isBlock(el: Element): boolean {
  if (INLINE_TAGS.has(el.tagName)) return false;
  let v = blockCache.get(el);
  if (v === undefined) {
    v = !getComputedStyle(el).display.startsWith('inline');
    blockCache.set(el, v);
  }
  return v;
}

// jsdom 无 innerText；页面上两者对可见文本块基本等价
const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();

/** 收集翻译单元：最深的、直接含文本的块级元素 */
export function scanUnits(root: Element = document.body): Element[] {
  const units: Element[] = [];
  const walk = (el: Element) => {
    if (el.matches(SKIP_SELECTOR) || (el as HTMLElement).hidden) return;
    let hasBlockChild = false;
    for (const child of el.children)
      if (isBlock(child)) {
        hasBlockChild = true;
        walk(child);
      }
    if (hasBlockChild) {
      // 混排容器（如 TOC：块级标题 + 行内链接列）：行内子项也逐个下钻，否则整列漏译
      // ponytail: 行内子项各自成单元，散文中的孤立行内片段会被单独翻译；真出问题再上行内 run 分组
      for (const child of el.children) if (!isBlock(child)) walk(child);
      return;
    }
    const text = textOf(el);
    // <2 字符或无字母（页码、图标符号）翻了也没意义
    if (text.length < 2 || !/\p{L}/u.test(text)) return;
    // 导航/菜单容器：自身无直接文本、含多个链接/按钮子项 → 逐项下钻，
    // 译文行内跟在各条目后，而不是整坨块级追加在容器底部
    const items = [...el.children].filter((c) => c.matches('a,button') && textOf(c).length >= 2);
    const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
    if (!ownText && items.length > 1) {
      items.forEach(walk);
      return;
    }
    units.push(el);
  };
  walk(root);
  return units;
}

/** 注入译文：inline/block 双轨启发式（短文本/行语境行内续排，正文换行成块）；导出供测试 */
export function inject(el: Element, translation: string) {
  const node = document.createElement(APP_TAG);
  node.className = 'notranslate';
  node.textContent = translation;
  const short = textOf(el).length < 24;
  const row = ['LI', 'DD', 'DT', 'TD', 'TH', 'CAPTION', 'BUTTON', 'A', 'SUMMARY', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']
    .includes(el.tagName);
  // 行内轨仅限短译文：nowrap 保证不逐字竖排、不在空格处拆行，放不下时整块下移；
  // 长译文即使在 TD/LI 里也换行成块正常折行，不撑爆表格列
  node.style.cssText = (short || row) && translation.length < 16
    ? 'display:inline-block;margin-left:.4em;white-space:nowrap;opacity:.85'
    : 'display:block;margin-top:.3em;opacity:.75';
  el.append(node); // 追加为最后一个子节点，原文文本节点原样保留
}

// ponytail: naive CJK 预筛，只对目标语言 zh/ja 有效；升级路径 = chrome.i18n.detectLanguage 逐段判定
const hasCJK = (s: string) => /[\u4e00-\u9fff\u3040-\u30ff]/.test(s);

let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;
const translated = new WeakSet<Element>();

/** 开始整页双语翻译：视口懒加载，进入视口的段落按 250ms 窗口聚合成批 */
export function startTranslate(to: string, onError?: (err: unknown) => void) {
  stopTranslate(); // 幂等：重复调用先清场

  const pending: Element[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    const batch = pending.splice(0);
    if (!batch.length) return;
    const texts = batch.map(textOf);
    try {
      const results: string[] = await browser.runtime.sendMessage({ type: 'translate', texts, to });
      // 按批写 DOM，读（scan）写（inject）不穿插，一次布局
      batch.forEach((el, i) => {
        if (results[i] && results[i] !== texts[i]) inject(el, results[i]);
      });
    } catch (err) {
      onError?.(err);
    }
  };

  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io!.unobserve(e.target);
      if (translated.has(e.target)) continue;
      translated.add(e.target);
      if ((to.startsWith('zh') || to === 'ja') && hasCJK(textOf(e.target))) continue; // 已是目标语言
      pending.push(e.target);
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    }
  }, { rootMargin: '200px 0px' }); // 提前 200px 预取，滚到时译文已就位

  scanUnits().forEach((el) => io!.observe(el));

  // 动态内容：只扫新增子树；自建节点靠 SKIP_SELECTOR + closest 双重过滤防自触发循环
  mo = new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes)
        if (n instanceof Element && !n.closest(APP_TAG))
          scanUnits(n).forEach((el) => {
            if (!translated.has(el)) io!.observe(el);
          });
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

/** 显隐切换：只翻 display，译文保留在 DOM 里，复显零 API 成本 */
export function setTranslationsVisible(show: boolean) {
  for (const n of document.querySelectorAll<HTMLElement>(APP_TAG))
    n.style.display = show ? '' : 'none';
}

/** 恢复原文：断开观察 + 移除所有注入节点，无需刷新 */
export function stopTranslate() {
  io?.disconnect();
  io = null;
  mo?.disconnect();
  mo = null;
  for (const n of document.querySelectorAll(APP_TAG)) n.remove();
}
