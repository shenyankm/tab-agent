import { useEffect, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { sendRequest } from "@/lib/messages";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Split a multi-line notes draft into trimmed, non-empty lines (options Clips
 *  editor and the content-side draft card share this one parser). */
export const parseNoteLines = (text: string): string[] =>
  text.split('\n').map((s) => s.trim()).filter(Boolean);

/** Subscribe to a WXT storage item: initial read + live watch across pages. */
export function useStorageValue<T>(
  item: { getValue(): Promise<T>; watch(cb: (value: T) => void): () => void },
  initial: T,
): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    setValue(initial); // item identity change (SPA nav → new key): reset, don't flash stale data
    // version guards the race where a watch callback lands before the initial read
    // resolves — a stale getValue result must not overwrite the newer watched value
    let version = 0;
    let active = true;
    // getValue rejects for proxied items once the extension context is invalidated
    // (reload/update) — swallow instead of flooding the page console
    item.getValue()
      .then((v) => { if (active && version === 0) setValue(v); })
      .catch(() => {});
    const unwatch = item.watch((v) => { if (active) { version++; setValue(v); } });
    return () => { active = false; unwatch(); };
  }, [item]);
  return value;
}

/** Subscribe to same-document navigations (SPA pushState/replaceState/popstate).
 * Chrome's navigation API (102+, our floor is 116) covers every case; elsewhere
 * degrades to popstate/hashchange — patching history.pushState from an isolated
 * world can't observe page-world calls, so pushState-only apps slip through there. */
export function onPageNav(cb: () => void): () => void {
  let last = location.href;
  const fire = () => {
    if (location.href === last) return;
    last = location.href;
    cb();
  };
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  if (nav) {
    nav.addEventListener('navigatesuccess', fire);
    return () => nav.removeEventListener('navigatesuccess', fire);
  }
  window.addEventListener('popstate', fire);
  window.addEventListener('hashchange', fire);
  // Firefox content scripts cannot observe page-world pushState from the
  // isolated world.经 background 向 MAIN world 注入一次性桥(包装
  // pushState/replaceState 派发窗口事件,DOM 事件跨世界可达);老 Firefox
  // (scripting MAIN world <128)注入失败退回 1s 轮询,桥先到则停表
  window.addEventListener('tab-agent-nav', fire);
  const timer = window.setInterval(fire, 1000);
  sendRequest<void>({ type: 'navBridge' })
    .then(() => window.clearInterval(timer))
    .catch(() => { /* 桥不可用:轮询兜底 */ });
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('tab-agent-nav', fire);
    window.removeEventListener('popstate', fire);
    window.removeEventListener('hashchange', fire);
  };
}
