import ReactDOM from 'react-dom/client';
import { FloatingAgent, showClip, clearAllMarks, pageMarkdown } from '@/components/floating-agent';
import { addClip, buildClipUrl, clipsPageItem, normalizeUrl, type Clip } from '@/lib/clips';
import { petEnabledItem, clipHighlightItem } from '@/lib/settings';
import '@/assets/content.css';

// 页面 meta 不可信:仅截断后存储用于展示/导出,不拼 HTML
const readPageMeta = () => {
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim().slice(0, 500) ?? '';
  const out: { author?: string; description?: string; published?: string } = {};
  const author = meta('meta[name="author"]');
  const description = meta('meta[name="description"], meta[property="og:description"]');
  const published = meta('meta[property="article:published_time"], meta[name="date"]');
  if (author) out.author = author;
  if (description) out.description = description;
  if (published) out.published = published;
  return out;
};

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // "save clip" from the background context menu: selection → text-fragment URL → storage
    browser.runtime.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type === 'saveClip') {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!sel || !text) return;
        addClip({
          url: buildClipUrl(location.href, sel),
          pageUrl: location.href,
          title: document.title,
          text,
          ...readPageMeta(),
        }).then(async (clip) => {
          // mark right away as save feedback, unless highlighting is switched off
          if (await clipHighlightItem.getValue()) showClip(clip, false);
        });
      }
      // 整页剪藏:Readability 正文(失败回退 innerText)进 fullText,text 留短摘要
      // 供列表/分类使用;无 fragment,不高亮(与裸 URL clip 语义一致)
      // ponytail: fullText 10万字符截断;整页 clip 多到拖慢 options getAll 时再拆独立 store
      if (msg?.type === 'saveClipPage') {
        const full = pageMarkdown();
        addClip({
          kind: 'page',
          url: location.href,
          pageUrl: location.href,
          title: document.title,
          text: full.slice(0, 500),
          fullText: full.slice(0, 100_000),
          ...readPageMeta(),
        });
      }
    });

    // re-apply saved highlights: text fragments only fire on navigation, not on reload
    // ponytail: one shot at document_idle; SPA content rendered later stays unmarked until clicked
    const page = normalizeUrl(location.href);
    const pageClips = clipsPageItem(page); // background 只回本页摘录,不再全量过通道
    // 开关每切换一次，在途的 idle 重放回调作废（否则关闭后残留回调会重新加 mark）
    let clipGen = 0;
    const replay = (clips: Clip[]) => {
      const gen = clipGen;
      for (const clip of clips)
        // idle-sliced: many clips on a big page must not stall first paint with one scan
        requestIdleCallback(() => {
          if (gen === clipGen) showClip(clip, false);
        }, { timeout: 2000 });
    };
    // 启动时高亮重放与 #clip=id 落地共用同一次读取
    const initial = pageClips.getValue();
    clipHighlightItem.getValue().then((on) => { if (on) initial.then(replay); });

    // 跨页跳转落地（options/面板回退打开的 #pixel-agent-clip=id）：走 showClip 同一条
    // 定位+滚动路径，高亮开关关闭时照常 3s 淡出；消费后清 hash，刷新不重闪
    const navClip = location.hash.match(/^#pixel-agent-clip=(.+)/)?.[1];
    if (navClip) {
      initial.then((clips) => {
        const clip = clips.find((c) => c.id === navClip);
        if (clip) showClip(clip);
      });
      history.replaceState(null, '', page);
    }
    // the popup switch takes effect live on open tabs
    clipHighlightItem.watch((on) => {
      clipGen++;
      if (on) return void pageClips.getValue().then(replay);
      clearAllMarks();
    });

    const mountUI = () => createShadowRootUi(ctx, {
      name: 'pixel-agent-floating-ui',
      position: 'inline',
      isolateEvents: true,
      onMount(container) {
        const root = ReactDOM.createRoot(container);
        root.render(<FloatingAgent />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    // pet toggle takes effect live: disabled = no React mount at all (spares the
    // runtime + heap on every page); every mount/remove runs on one chain so rapid
    // toggles can't race. 取舍：关闭即卸载——进行中的回答中断、重开后聊天记录重置
    // （性能优先，与"关闭宠物"的用户意图一致）
    let ui: Awaited<ReturnType<typeof mountUI>> | null = null;
    let mountChain: Promise<void> = Promise.resolve();
    const sync = (on: boolean) => {
      mountChain = mountChain.then(async () => {
        if (on && !ui) {
          ui = await mountUI();
          ui.mount();
        } else if (!on && ui) {
          ui.remove();
          ui = null;
        }
      });
    };
    petEnabledItem.watch(sync);
    // 初始挂载走同一条链：与切换互斥，避免双挂载或禁用状态下挂载
    sync(await petEnabledItem.getValue());
    await mountChain;
  },
});
