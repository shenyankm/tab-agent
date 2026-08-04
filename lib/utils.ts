import { useEffect, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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
    // getValue rejects for proxied items once the extension context is invalidated
    // (reload/update) — swallow instead of flooding the page console
    item.getValue()
      .then((v) => { if (version === 0) setValue(v); })
      .catch(() => {});
    return item.watch((v) => { version++; setValue(v); });
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
  return () => {
    window.removeEventListener('popstate', fire);
    window.removeEventListener('hashchange', fire);
  };
}
