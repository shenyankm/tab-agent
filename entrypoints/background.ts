import { dict, langItem, DEFAULT_LANG, type Lang, type I18nKey } from '@/lib/i18n';
import { getClipsDirect, getClipsForPageDirect, addClipDirect, removeClipDirect, updateClipDirect, updateClipsDirect, type Clip } from '@/lib/clips-store';
import { CLIPS_CHANGED, type Request } from '@/lib/messages';
import { handleChat, keepalive, type ChatOut, type PageContext } from '@/lib/gateway';
import { classifyBatch, CLASSIFY_BATCH } from '@/lib/classify';
import { syncAllClipsToMemoryStore, deleteClipFromMemoryStore, syncUsageToMemoryStore, mirrorClip } from '@/lib/memory';
import { syncDeployment, buildInstruction } from '@/lib/daily-report';
import { logChat, logClipAdded, logClassified, purgeOld, today } from '@/lib/usage';
import { memorySyncItem, notionDbIdItem, dailyReportItem, patItem } from '@/lib/settings';

// fan clipsChanged out to content scripts in every tab and to extension pages
// (options) which tabs.sendMessage can't reach. page (the changed clip's
// normalized pageUrl) lets page watchers skip other pages' changes; omitted when
// a change spans pages (classify), so every watcher refreshes.
function fanOutClipsChanged(page?: string) {
  const msg = { type: CLIPS_CHANGED, page };
  browser.tabs
    .query({})
    .then((tabs) => {
      for (const tab of tabs)
        if (tab.id)
          browser.tabs.sendMessage(tab.id, msg).catch(() => {
            /* no content script on this tab */
          });
    })
    .catch(() => {
      /* tabs.query failed */
    });
  // runtime.sendMessage reaches extension pages (options) but not content scripts;
  // background itself has no watcher, so no echo to worry about here.
  void browser.runtime.sendMessage(msg).catch(() => {
    /* no extension page listening */
  });
}

/** Send all clips to the cloud agent for knowledge-type classification, parse the
 *  JSON response and write category/relatedIds back to each clip, batch by batch. */
async function handleClassify(): Promise<{ classified: number }> {
  const clips = await getClipsDirect();
  if (!clips.length) return { classified: 0 };

  // one dedicated gateway session for the whole run: force-creating per batch
  // would litter the user's session list with N/50 throwaway "Pixel Agent" entries
  const session = { id: '' };
  let classified = 0;
  for (let i = 0; i < clips.length; i += CLASSIFY_BATCH) {
    // write each batch back as it lands: a later batch's failure keeps earlier progress
    const patches = await classifyBatch(clips.slice(i, i + CLASSIFY_BATCH), session);
    await updateClipsDirect(patches);
    classified += patches.length;
  }
  fanOutClipsChanged();
  if (classified) logClassified();
  // 分类写回后镜像到云端记忆(默认关闭);失败只影响镜像,本地 IDB 是事实源
  if (await memorySyncItem.getValue())
    void syncAllClipsToMemoryStore().catch((e) => console.error('[pixel-agent]', e));
  return { classified };
}

// concurrent classify triggers (two options tabs) share one run — parallel runs
// would double the LLM cost and race the write-back
let classifyInFlight: Promise<{ classified: number }> | null = null;

// 云端记忆改为写入即自动镜像;开关打开时对存量摘录库补一次全量,共享单次运行避免并发重复写
let memorySyncInFlight: Promise<number> | null = null;

// "立即生成日报"共享单次运行:一次性专用会话(ownSession=''),同 classify 模式
let reportInFlight: Promise<{ day: string }> | null = null;

async function runDailyReportNow(): Promise<{ day: string }> {
  const [pat, dbId] = await Promise.all([patItem.getValue(), notionDbIdItem.getValue()]);
  if (!pat || !dbId) throw new Error('daily report not configured');
  // 手动触发总结截至此刻的当日记录;回复经 send 丢弃,只要回合正常结束即视为完成
  await handleChat(buildInstruction(dbId), undefined, false, new AbortController().signal, () => {}, '');
  return { day: today() };
}

export default defineBackground(() => {
  // warm the extension-origin DB at startup
  void getClipsDirect().catch(() => {
    /* open failed; next access retries */
  });
  // 清理过期使用日志(保留 7 天);失败下次启动重试
  void purgeOld();

  // 日报 Deployment 收敛:开关/Notion DB ID 变更时把云端状态拉回一致
  const resync = () => void syncDeployment().catch((e) => console.error('[pixel-agent]', e));
  dailyReportItem.watch(resync);
  notionDbIdItem.watch(resync);

  // 记忆同步开关打开 → 存量摘录一次性全量补齐(此后新增/更新/删除自动镜像)
  memorySyncItem.watch((on) => {
    if (!on || memorySyncInFlight) return;
    const ping = keepalive();
    memorySyncInFlight = syncAllClipsToMemoryStore()
      .catch((e) => { console.error('[pixel-agent]', e); return 0; })
      .finally(() => { memorySyncInFlight = null; clearInterval(ping); });
  });

  // "save clip" context menus; titles follow the UI language
  const MENU_TITLES = {
    'save-clip': 'clips.menu',
    'save-clip-page': 'clips.menu.page',
    'save-clip-image': 'clips.menu.image',
  } as const;
  // storage can hold a stale/invalid lang (old version, manual edit) — an
  // undefined dict row here would crash onInstalled and no menu would ever be
  // created; same fallback chain as t()
  const menuText = (lang: Lang, key: string) =>
    (dict[lang] as Record<string, string> | undefined)?.[key] ?? dict[DEFAULT_LANG][key as I18nKey];
  browser.runtime.onInstalled.addListener(async () => {
    const lang = await langItem.getValue();
    // removeAll first: onInstalled also fires on update, create() with an existing id errors;
    // must await — create() racing ahead of removeAll hits the same duplicate-id error
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: 'save-clip', title: menuText(lang, 'clips.menu'), contexts: ['selection'] });
    browser.contextMenus.create({ id: 'save-clip-page', title: menuText(lang, 'clips.menu.page'), contexts: ['page'] });
    browser.contextMenus.create({ id: 'save-clip-image', title: menuText(lang, 'clips.menu.image'), contexts: ['image'] });
  });
  langItem.watch((lang) => {
    for (const [id, key] of Object.entries(MENU_TITLES))
      // update() rejects if the menu id is gone (e.g. before onInstalled ran) — non-fatal
      browser.contextMenus.update(id, { title: menuText(lang, key) }).catch(() => {});
  });
  // the content script owns selection/page saves: it has the live Selection and DOM
  const saveClipToTab = (tabId: number, type: 'saveClip' | 'saveClipPage' = 'saveClip') =>
    browser.tabs.sendMessage(tabId, { type }).catch(() => {
      /* no content script on this page (chrome://, store) */
    });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === 'save-clip') return saveClipToTab(tab.id);
    if (info.menuItemId === 'save-clip-page') return saveClipToTab(tab.id, 'saveClipPage');
    // image clip also goes through the content script: page side reads
    // location.href/document.title with zero permissions — background would need
    // the broad "tabs" permission ("browsing history" install warning) otherwise
    const altText = (info as { altText?: string }).altText;
    if (info.menuItemId === 'save-clip-image' && info.srcUrl) {
      const srcUrl = info.srcUrl;
      return void browser.tabs.sendMessage(tab.id, { type: 'saveClipImage', srcUrl, altText }).catch(() =>
        // no content script (chrome://, store): degraded save, page = the image itself
        addClipDirect({
          kind: 'image', url: srcUrl, pageUrl: srcUrl, title: '',
          text: altText || srcUrl, imageSrc: srcUrl,
        }).then((clip) => fanOutClipsChanged(clip.pageUrl)).catch(() => {
          /* write failed; menu click has no surface to report on */
        }),
      );
    }
  });

  // 剪藏快捷键:对活动页复用 content script 的保存路径(选区→fragment→storage)
  browser.commands.onCommand.addListener((command) => {
    if (command !== 'save_clip') return;
    browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (tab?.id) saveClipToTab(tab.id);
      })
      .catch(() => {
        /* no active tab */
      });
  });

  // clips live in the extension origin's IndexedDB; background is the sole writer.
  // Content scripts (page origin, per-site isolated IDB) proxy reads/writes here.
  // return true keeps the message channel open for the async sendResponse; every
  // branch resolves {ok:true,data} or {ok:false,error} so the sender never hangs.
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const ok = (data: unknown) => sendResponse({ ok: true, data });
    const fail = (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
    const req = msg as Request;
    if (req?.type === 'clipsGet') {
      getClipsDirect().then(ok, fail);
      return true;
    }
    // 只回本页摘录:content 端每次 clipsChanged 刷新不再搬全量表过消息通道;
    // pageUrl 索引让读取本身也是 O(本页) 而非全表扫描
    if (req?.type === 'clipsGetForPage') {
      // 无 page 时 index.getAll(undefined) 按 WebIDL 语义等于无查询——会回全表
      if (typeof req.page !== 'string' || !req.page) {
        fail(new Error('invalid page'));
        return true;
      }
      getClipsForPageDirect(req.page).then(ok, fail);
      return true;
    }
    if (req?.type === 'clipAdd') {
      // page messages are untrusted — same defense-in-depth as sanitizePatch: a dirty
      // type (e.g. text: {}) in the DB crashes React rendering downstream. Lenient:
      // text required, every other field validated only when present.
      const c = msg.clip as Record<string, unknown> | undefined;
      const optStr = (v: unknown) => v === undefined || typeof v === 'string';
      const optStrArr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
      const valid = !!c && typeof c === 'object' && typeof c.text === 'string'
        && optStr(c.url) && optStr(c.pageUrl) && optStr(c.title) && optStr(c.imageSrc) && optStr(c.category)
        && (c.kind === undefined || c.kind === 'page' || c.kind === 'image')
        && optStrArr(c.tags) && optStrArr(c.notes) && optStrArr(c.relatedIds);
      if (!valid) {
        fail(new Error('invalid clip payload'));
        return true;
      }
      addClipDirect(msg.clip as Omit<Clip, 'id' | 'createdAt'>).then((clip) => {
        fanOutClipsChanged(clip.pageUrl);
        logClipAdded();
        void mirrorClip(clip).catch(() => {}); // 自动镜像(开关关时内部 no-op),失败不影响本地
        ok(clip);
      }, fail);
      return true;
    }
    if (req?.type === 'clipDel') {
      removeClipDirect(req.id).then((page) => {
        fanOutClipsChanged(page);
        // 云端镜像同步删除(默认关闭):本地已删,镜像残留会误导 Agent,尽力清理
        void memorySyncItem.getValue().then((on) => {
          if (on) deleteClipFromMemoryStore(req.id).catch(() => { /* 镜像删除失败静默 */ });
        });
        ok(undefined);
      }, fail);
      return true;
    }
    if (req?.type === 'clipUpdate') {
      updateClipDirect(req.id, req.patch).then((page) => {
        fanOutClipsChanged(page);
        ok(undefined);
        // 更新后把合并结果重推镜像:updateClipDirect 不回传合并行,回读查找
        // (摘录更新低频,O(n) 无碍);镜像失败静默,本地是事实源
        void getClipsDirect()
          .then((clips) => clips.find((c) => c.id === req.id))
          .then((clip) => clip && mirrorClip(clip))
          .catch(() => {});
      }, fail);
      return true;
    }
    if (req?.type === 'classifyClips') {
      // classify (LLM generation + N IDB writes) easily exceeds the 30s worker cap
      const ping = keepalive();
      classifyInFlight ??= handleClassify().finally(() => { classifyInFlight = null; });
      classifyInFlight.then(ok, fail).finally(() => clearInterval(ping));
      return true;
    }
    if (req?.type === 'dailyReportNow') {
      // 手动生成是一个完整 Agent 回合(总结 + 写 Notion):keepalive + 共享单次运行
      const ping = keepalive();
      reportInFlight ??= runDailyReportNow().finally(() => { reportInFlight = null; });
      reportInFlight.then(ok, fail).finally(() => clearInterval(ping));
      return true;
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chat') return;
    const abort = new AbortController();
    port.onDisconnect.addListener(() => abort.abort());
    port.onMessage.addListener((msg: { text: string; page?: PageContext; screenshot?: boolean }) => {
      // port payloads are untrusted-ish (own content scripts today, but cheap to
      // guard): a non-string text would crash handleChat far from the cause
      if (typeof msg?.text !== 'string' || !msg.text) return;
      let reply = '';
      const send = (out: ChatOut) => {
        // 回合成功结束时记一笔使用日志并 best-effort 镜像到云端(日报数据源)
        if (out.type === 'delta') reply += out.text;
        if (out.type === 'done') {
          logChat(msg.text, reply);
          void syncUsageToMemoryStore(today()).catch(() => {});
        }
        try {
          port.postMessage(out);
        } catch {
          /* port closed */
        }
      };
      // a screenshot turn (tool call + thinking) can stream nothing for that long
      const ping = keepalive();
      handleChat(msg.text, msg.page, !!msg.screenshot, abort.signal, send, undefined, {
        tabId: port.sender?.tab?.id,
        windowId: port.sender?.tab?.windowId,
      })
        .catch((err) => {
          console.error('[pixel-agent]', err); // port may be gone; keep a trace in the SW console
          if (!abort.signal.aborted)
            send({ type: 'error', code: err?.code, message: String(err?.message ?? err) });
        })
        .finally(() => clearInterval(ping));
    });
  });

  // cleanup session keys for closed tabs
  browser.tabs.onRemoved.addListener((tabId) => {
    storage.removeItem(`local:sessionId.v4.tab.${tabId}`).catch(() => {});
  });
});
