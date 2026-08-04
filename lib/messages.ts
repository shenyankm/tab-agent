// Runtime message protocol: the single typed contract between senders (content
// scripts, options pages) and the receiver (background's message proxy).
// Request is a discriminated union — adding a type here makes the compiler find
// every sender and handler. No DOM imports: background bundles this module.
import type { Clip, ClipPatch } from '@/lib/clips-store';

// change broadcast, background → every tab's content script + extension pages.
// page (normalized pageUrl) lets page watchers skip other pages' changes; it is
// omitted for multi-page changes (classify) so every watcher refreshes.
export const CLIPS_CHANGED = 'clipsChanged';

export type Request =
  | { type: 'clipsGet' }
  | { type: 'clipsGetForPage'; page: string }
  | { type: 'clipAdd'; clip: Omit<Clip, 'id' | 'createdAt'> }
  | { type: 'clipDel'; id: string }
  | { type: 'clipUpdate'; id: string; patch: ClipPatch }
  | { type: 'classifyClips' };

// every handler branch resolves this envelope — failures RESOLVE {ok:false},
// they don't reject, so the sender never hangs
export type Reply<T> = { ok: true; data: T } | { ok: false; error?: string };

/** Send a request through the background proxy and unwrap the reply envelope. */
export async function sendRequest<T>(msg: Request): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as Reply<T>;
  if (!res?.ok) throw new Error(res?.error ?? 'request failed');
  return res.data;
}
