import { addClip, clipsPageItem, normalizeUrl, type Clip } from '@/lib/clips-store';
import { CLIPS_CHANGED } from '@/lib/messages';
import { onPageNav } from '@/lib/utils';
import { petEnabledItem, clipHighlightItem, highlightColorItem } from '@/lib/settings';
import '@/assets/content.css';

type MarksModule = typeof import('@/lib/marks');
type HighlightModule = typeof import('@/lib/clips-highlight');
let marksModule: Promise<MarksModule> | null = null;
let highlightModule: Promise<HighlightModule> | null = null;
let loadedMarks: MarksModule | null = null;
const loadMarks = () => marksModule ??= import('@/lib/marks').then((module) => {
  loadedMarks = module;
  return module;
});
const loadHighlight = () => highlightModule ??= import('@/lib/clips-highlight');

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle', // explicit: the replay/landing flow below assumes DOM ready
  async main(ctx) {
    // "save clip" from the background context menu: selection → text-fragment URL →
    // 编辑卡片（宠物 UI 在挂载时）→ storage；fragment 必须在选区还活着时生成
    // 注册到 background 的 content-script 注册表:fanOutClipsChanged 只向注册
    // tab 广播,不再全量 tabs.query;SPA 导航后 page 变化要重注册
    const registerTab = () => {
      // 扩展更新/重载后旧上下文失效,sendMessage 会 reject——吞掉,
      // 否则页面控制台刷 unhandled rejection
      browser.runtime.sendMessage({ type: 'tabRegister', page: normalizeUrl(location.href) })
        .catch(() => { /* invalidated context */ });
    };
    registerTab();

    const onMessage = (msg: { type?: string; srcUrl?: string; altText?: string }) => {
      // SW 重启后注册表被清空,fanOut 回退全量广播;收到广播即重注册,恢复精准投递。
      // 同时刷新本页 mark:面板关闭时(无 watch 订阅)广播是唯一能触发重放的路径——
      // 删除 clip 后残留 mark 在此清理;clipGen++ 作废在途 idle 回调,
      // 避免已删 clip 的 mark 被重放复活
      if (msg?.type === CLIPS_CHANGED) {
        registerTab();
        clipGen++;
        if (highlightOn) pageClips.getValue().then(replay).catch(() => {});
        return;
      }
      if (msg?.type === 'saveClip') {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!sel || !text) return;
        void Promise.all([loadMarks(), loadHighlight()]).then(([marks, highlight]) =>
          marks.saveClipDraft({
            url: highlight.buildClipUrl(location.href, sel),
            pageUrl: location.href,
            title: document.title,
            text,
          }),
        ).catch(() => {});
      }
      // 整页剪藏:Readability 正文(失败回退 innerText)截短存进 text,
      // 供列表/分类使用;无 fragment,不高亮(与裸 URL clip 语义一致)
      if (msg?.type === 'saveClipPage') {
        void import('@/lib/page-text').then(({ pageText }) => addClip({
          kind: 'page',
          url: location.href,
          pageUrl: location.href,
          title: document.title,
          text: pageText().slice(0, 500),
        })).catch(() => { /* 写入失败(上下文失效/IDB 错误):菜单动作无反馈面 */ });
      }
      // 图片剪藏也走页面侧:location.href/document.title 无需权限——background 读
      // tab.url/title 需要 broad "tabs" 权限(带"浏览历史"安装警告),least privilege
      if (msg?.type === 'saveClipImage' && typeof msg.srcUrl === 'string') {
        const img = [...document.images].find((i) => i.src === msg.srcUrl || i.currentSrc === msg.srcUrl);
        addClip({
          kind: 'image',
          url: msg.srcUrl,
          pageUrl: location.href,
          title: document.title,
          text: (typeof msg.altText === 'string' && msg.altText) || img?.alt || msg.srcUrl,
          imageSrc: msg.srcUrl,
        }).catch(() => { /* 同上:无反馈面,静默失败 */ });
      }
    };
    browser.runtime.onMessage.addListener(onMessage);

    // re-apply saved highlights: text fragments only fire on navigation, not on reload
    // MutationObserver catches SPA content rendered after document_idle so it gets marked too
    let page = normalizeUrl(location.href);
    let pageClips = clipsPageItem(page); // background 只回本页摘录,不再全量过通道
    // 开关每切换一次，在途的 idle 重放回调作废（否则关闭后残留回调会重新加 mark）
    let clipGen = 0;
    let highlightOn = false; // 内存镜像开关:observer 回调短路,不必每次读 storage
    let spaTimer: ReturnType<typeof setTimeout> | null = null;
    let spaObserver: MutationObserver | null = null;

    const stopSpaObserver = () => {
      if (spaTimer) clearTimeout(spaTimer);
      spaTimer = null;
      spaObserver?.disconnect();
      spaObserver = null;
    };

    const startSpaObserver = () => {
      if (spaObserver || !highlightOn || !document.body) return;
      spaObserver = new MutationObserver(() => {
        if (spaTimer || !highlightOn) return;
        spaTimer = setTimeout(() => {
          spaTimer = null;
          if (!highlightOn) return;
          clipGen++; // 作废旧 mark,重新定位(持续变化的页面以 2s 窗口收敛)
          pageClips.getValue().then(replay).catch(() => {});
        }, 2000);
      });
      spaObserver.observe(document.body, { childList: true, subtree: true });
    };

    const replay = (clips: Clip[]) => {
      const keep = new Set(clips.map((c) => c.id));
      if (!highlightOn || !clips.length) {
        // 没有加载过高亮模块时，没有残留 mark 需要清理。
        if (loadedMarks) loadedMarks.pruneMarks(keep);
        else if (marksModule) void marksModule.then(({ pruneMarks }) => pruneMarks(keep));
        if (!clips.length) stopSpaObserver();
        return;
      }
      startSpaObserver();
      const gen = clipGen;
      void loadMarks().then(({ pruneMarks, showClip }) => {
        pruneMarks(keep);
        if (!highlightOn || gen !== clipGen) return;
        let index = 0;
        const pump = (deadline?: IdleDeadline) => {
          const started = Date.now();
          while (index < clips.length && gen === clipGen) {
            showClip(clips[index++], false);
            // Keep each idle slice short even when the browser reports unlimited time.
            if (deadline && deadline.timeRemaining() < 2) break;
            if (Date.now() - started >= 8) break;
          }
          if (index < clips.length && gen === clipGen)
            requestIdleCallback(pump, { timeout: 2000 });
        };
        // idle-sliced: many clips on a big page must not stall first paint with one scan
        requestIdleCallback(pump, { timeout: 2000 });
      }).catch(() => {});
    };

    // 跨页跳转落地（options/面板回退打开的 #tab-agent-clip=id）：走 showClip 同一条
    // 定位+滚动路径，高亮开关关闭时照常 3s 淡出；消费后清 hash，刷新不重闪
    const navClip = location.hash.match(/^#tab-agent-clip=(.+)/)?.[1];
    // 启动时只有高亮开启或需要落地某条摘录时才读取本页数据。
    // 高亮关闭且没有导航目标时，普通网页不再为摘录支付一次 IPC/IDB 查询。
    const initial = clipHighlightItem.getValue()
      .then((on) => {
        highlightOn = on;
        if (!on && !navClip) return [] as Clip[];
        return pageClips.getValue();
      })
      .catch(() => [] as Clip[]);
    initial.then((clips) => {
      if (highlightOn) replay(clips);
      if (navClip) {
        const clip = clips.find((c) => c.id === navClip);
        if (clip) void loadMarks().then(({ showClip }) => showClip(clip)).catch(() => {});
      }
    });
    if (navClip) {
      // 只剥 #tab-agent-clip= 段:规范化 URL 会把 utm 等参数从地址栏抹掉(影响复制/书签)
      history.replaceState(null, '', location.pathname + location.search);
    }
    // the popup switch takes effect live on open tabs
    const unwatchHighlight = clipHighlightItem.watch((on) => {
      clipGen++;
      highlightOn = on;
      if (on) return void pageClips.getValue().then(replay).catch(() => { /* invalidated context */ });
      stopSpaObserver();
      if (loadedMarks) loadedMarks.clearAllMarks();
      else if (marksModule) void marksModule.then(({ clearAllMarks }) => clearAllMarks());
    });
    // 设置页换高亮色:已打开的页面里在页 mark 即时补色
    const unwatchColor = highlightColorItem.watch((color) => {
      if (loadedMarks) loadedMarks.restyleMarks(color);
      else if (marksModule) void marksModule.then(({ restyleMarks }) => restyleMarks(color));
    });

    // SPA 同文档导航:重锚本页摘录、清掉旧页 mark、按新 URL 重放高亮
    const unsubNav = onPageNav(() => {
      page = normalizeUrl(location.href);
      pageClips = clipsPageItem(page);
      clipGen++; // 作废旧页在途的 idle 重放
      stopSpaObserver();
      if (loadedMarks) loadedMarks.clearAllMarks();
      else if (marksModule) void marksModule.then(({ clearAllMarks }) => clearAllMarks());
      registerTab(); // 注册表里的 page 跟着 SPA 导航更新
      if (highlightOn) pageClips.getValue().then(replay).catch(() => {});
    });
    // dev HMR 下脚本失效重跑会叠加监听;生产与页面同生命周期,注销是 no-op
    let invalidated = false;
    ctx.onInvalidated(() => {
      invalidated = true;
      browser.runtime.onMessage.removeListener(onMessage);
      unwatchHighlight();
      unwatchColor();
      unsubNav();
      stopSpaObserver();
    });

    // UI 树(React + 组件 + markdown 解析)走动态 import:WXT 0.20 对 content
    // script 强制 IIFE 输出,动态块会被内联(暂无拆分收益),但结构上主包不
    // 再静态依赖 React——WXT 支持 content 代码拆分后此处在构建期自动生效
    const mountUI = async () => {
      const { mountFloatingAgent } = await import('@/components/floating-agent');
      // 动态 import 期间上下文被 invalidated(扩展更新/重载):此时 mount 只会
      // 在失效上下文里创建 shadow UI,残留到页面导航——直接放弃
      if (invalidated) throw new Error('context invalidated during UI load');
      return createShadowRootUi(ctx, {
        name: 'tab-agent-floating-ui',
        position: 'inline',
        isolateEvents: true,
        onMount(container) {
          return mountFloatingAgent(container);
        },
        onRemove(root) {
          root?.unmount();
        },
      });
    };

    // pet toggle takes effect live: disabled = no React mount at all (spares the
    // runtime + heap on every page); every mount/remove runs on one chain so rapid
    // toggles can't race. 取舍：关闭即卸载——进行中的回答中断、重开后聊天记录重置
    // （性能优先，与"关闭宠物"的用户意图一致）
    let ui: Awaited<ReturnType<typeof mountUI>> | null = null;
    let mountChain: Promise<void> = Promise.resolve();
    const sync = (on: boolean) => {
      // 链上兜底:mountUI 失败(动态 import 错误/invalidated)只记日志不断链,
      // 否则后续 pet 开关全部被跳过且 main() 末尾 await 抛未捕获异常
      mountChain = mountChain
        .then(async () => {
          if (on && !ui) {
            ui = await mountUI();
            ui.mount();
          } else if (!on && ui) {
            ui.remove();
            ui = null;
          }
        })
        .catch((e) => console.error('[tab-agent] mount:', e));
    };
    const unwatchPet = petEnabledItem.watch(sync);
    ctx.onInvalidated(unwatchPet);
    // 初始挂载走同一条链：与切换互斥，避免双挂载或禁用状态下挂载
    sync(await petEnabledItem.getValue());
    await mountChain;
  },
});
