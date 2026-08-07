import { dict, langItem, DEFAULT_LANG, type Lang, type I18nKey } from '@/lib/i18n';
import { getClipsDirect, getClipsForPageDirect, addClipDirect, removeClipDirect, updateClipDirect, type Clip } from '@/lib/clips-store';
import { CLIPS_CHANGED, type Request } from '@/lib/messages';
import { handleChat, keepalive, type ChatOut, type PageContext } from '@/lib/gateway';

// content script 注册表(tabId → normalized pageUrl):fanOut 只向注册 tab 广播,
// 免掉全量 tabs.query + 对无 content 脚本的 tab(chrome://、PDF 等)的无效 IPC。
// content 脚本启动/SPA 导航时发 tabRegister;tab 关闭由 onRemoved 清理。
// SW 重启后注册表清空:fanOut 回退全量广播,content 脚本收到广播即重注册,
// 一次广播后恢复精准投递。
const contentTabs = new Map<number, string>();
browser.tabs.onRemoved.addListener((tabId) => { contentTabs.delete(tabId); });

/** Test-only: clear the content-script registry between test cases. */
export function clearContentTabsForTests() {
  contentTabs.clear();
}

// fan clipsChanged out to registered content scripts and to extension pages
// (options) which tabs.sendMessage can't reach. page (the changed clip's
// normalized pageUrl) lets page watchers skip other pages' changes; omitted when
// a change spans pages, so every watcher refreshes.
function fanOutClipsChanged(page?: string) {
  const msg = { type: CLIPS_CHANGED, page };
  let delivered = 0;
  const deliver = (tabId: number) =>
    browser.tabs.sendMessage(tabId, msg)
      .then(() => { delivered++; })
      .catch((e) => {
        // 导航走/无内容脚本的 tab:清理陈旧条目(整页导航到 chrome:// 等不会
        // 重注册也不会注销,不清理则每次广播都白发一次必然 reject 的 IPC);
        // 该 tab 回到匹配页时启动会重新注册,闭环不受影响。re-throw 让
        // allSettled 能看到投递失败(否则 catch 吞掉后永远 fulfilled,回退不触发)
        contentTabs.delete(tabId);
        throw e;
      });
  // 注册表为空(SW 重启后首次广播)时回退全量:content 收到后重注册,下次恢复精准。
  // 混合版本窗口:更新后只要有一个新脚本注册就切精准模式,未刷新 tab 上的旧版
  // 脚本(无 tabRegister 逻辑)永远收不到——有明确目标但全部失效时回退一次全量
  const targets = contentTabs.size
    ? [...contentTabs].filter(([, registeredPage]) => !page || registeredPage === page).map(([tabId]) => tabId)
    : undefined;
  if (targets?.length) {
    // 精准投递全部落空(注册表里都是失效/旧版 tab)时回退一次全量广播
    void Promise.allSettled(targets.map(deliver)).then((rs) => {
      if (rs.every((r) => r.status === 'rejected')) {
        void browser.tabs.query({}).then((tabs) => {
          for (const tab of tabs) if (tab.id) deliver(tab.id).catch(() => {});
        }).catch(() => {});
      }
    });
  } else if (!targets) {
    void browser.tabs.query({}).then((tabs) => {
      for (const tab of tabs) if (tab.id) deliver(tab.id);
    }).catch(() => {});
  }
  // runtime.sendMessage reaches extension pages (options) but not content scripts;
  // background itself has no watcher, so no echo to worry about here.
  void browser.runtime.sendMessage(msg).then(() => { delivered++; }).catch(() => {
    /* no extension page listening */
  });
  // all-silent = every context lost (e.g. post-update with no re-injected scripts);
  // options would show stale data with no clue why
  setTimeout(() => { if (!delivered) console.warn('[tab-agent] clipsChanged reached no listener'); }, 1000);
}

export default defineBackground(() => {
  // last-resort logger: individual .catch() calls are the primary defense, but a
  // missed one must not go silently — SW console is the only surface we have
  self.addEventListener('unhandledrejection', (e) => console.error('[tab-agent] unhandled:', e.reason));

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
    // content script 注册(fire-and-forget,不响应):background 只记 tabId → page
    if ((msg as { type?: string })?.type === 'tabRegister') {
      const page = (msg as { page?: string })?.page;
      if (sender.tab?.id) {
        if (page) contentTabs.set(sender.tab.id, page);
        else contentTabs.delete(sender.tab.id);
      }
      return;
    }
    const ok = (data: unknown) => sendResponse({ ok: true, data });
    const fail = (e: unknown, code?: string) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e), code });
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
        fail(new Error('invalid page'), 'invalid');
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
        && optStrArr(c.tags) && optStrArr(c.notes);
      if (!valid) {
        fail(new Error('invalid clip payload'), 'invalid');
        return true;
      }
      addClipDirect(msg.clip as Omit<Clip, 'id' | 'createdAt'>).then((clip) => {
        fanOutClipsChanged(clip.pageUrl);
        ok(clip);
      }, fail);
      return true;
    }
    if (req?.type === 'clipDel') {
      removeClipDirect(req.id).then((page) => {
        fanOutClipsChanged(page);
        ok(undefined);
      }, fail);
      return true;
    }
    if (req?.type === 'clipUpdate') {
      updateClipDirect(req.id, req.patch).then((page) => {
        fanOutClipsChanged(page);
        ok(undefined);
      }, fail);
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
      const send = (out: ChatOut) => {
        try {
          port.postMessage(out);
        } catch {
          /* port closed */
        }
      };
      // a screenshot turn (tool call + thinking) can stream nothing for that long
      const ping = keepalive();
      handleChat(msg.text, msg.page, !!msg.screenshot, abort.signal, send, {
        windowId: port.sender?.tab?.windowId,
      }, (day) => {
        // 回复完成日落进会话缓存：跨午夜回合（23:56 发、00:12 答完）仍属旧会话，
        // 下一条消息才触发跨天重建 + 旧会话自总结。读-改-写保留 id，只刷 day。
        void storage.getItem<{ id: string; day: string }>('local:sessionId.v4')
          .then((c) => c && storage.setItem('local:sessionId.v4', { ...c, day }))
          .catch(() => console.warn('[tab-agent] session day not persisted'));
      })
        .catch((err) => {
          console.error('[tab-agent]', err); // port may be gone; keep a trace in the SW console
          if (!abort.signal.aborted)
            send({ type: 'error', code: err?.code, message: String(err?.message ?? err) });
        })
        .finally(() => clearInterval(ping));
    });
  });
});
