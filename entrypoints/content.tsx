import ReactDOM from 'react-dom/client';
import { FloatingAgent, showClip, clearAllMarks } from '@/components/floating-agent';
import { addClip, buildClipUrl, clipsItem, normalizeUrl } from '@/lib/clips';
import { petEnabledItem, clipHighlightItem } from '@/lib/settings';
import '@/assets/content.css';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // "save clip" from the background context menu: selection → text-fragment URL → storage
    browser.runtime.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type !== 'saveClip') return;
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!sel || !text) return;
      addClip({
        url: buildClipUrl(location.href, sel),
        pageUrl: location.href,
        title: document.title,
        text,
      }).then(async (clip) => {
        // mark right away as save feedback, unless highlighting is switched off
        if (await clipHighlightItem.getValue()) showClip(clip, false);
      });
    });

    // re-apply saved highlights: text fragments only fire on navigation, not on reload
    // ponytail: one shot at document_idle; SPA content rendered later stays unmarked until clicked
    const page = normalizeUrl(location.href);
    // 开关每切换一次，在途的 idle 重放回调作废（否则关闭后残留回调会重新加 mark）
    let clipGen = 0;
    const applyAll = async () => {
      const gen = clipGen;
      for (const clip of await clipsItem.getValue())
        if (normalizeUrl(clip.pageUrl) === page)
          // idle-sliced: many clips on a big page must not stall first paint with one scan
          requestIdleCallback(() => {
            if (gen === clipGen) showClip(clip, false);
          }, { timeout: 2000 });
    };
    clipHighlightItem.getValue().then((on) => { if (on) applyAll(); });

    // 跨页跳转落地（options/面板回退打开的 #pixel-agent-clip=id）：走 showClip 同一条
    // 定位+滚动路径，高亮开关关闭时照常 3s 淡出；消费后清 hash，刷新不重闪
    const navClip = location.hash.match(/^#pixel-agent-clip=(.+)/)?.[1];
    if (navClip) {
      clipsItem.getValue().then((clips) => {
        const clip = clips.find((c) => c.id === navClip);
        if (clip) showClip(clip);
      });
      history.replaceState(null, '', page);
    }
    // the popup switch takes effect live on open tabs
    clipHighlightItem.watch((on) => {
      clipGen++;
      if (on) return void applyAll();
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
