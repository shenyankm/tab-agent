import { describe, it, expect, vi, beforeEach } from 'vitest';

// The existing suite mocks defineContentScript to a pass-through but never executes
// main() — these tests capture the definition and drive main(ctx) by hand, so the
// clipGen guard around the idle-callback highlight replay is actually covered.

const {
  mockShowClip, mockClearAllMarks, mockClipsGet, mockHighlightGet, mockPetGet,
  highlightWatchRef, defRef,
} = vi.hoisted(() => ({
  mockShowClip: vi.fn(),
  mockClearAllMarks: vi.fn(),
  mockClipsGet: vi.fn().mockResolvedValue([]),
  mockHighlightGet: vi.fn().mockResolvedValue(true),
  mockPetGet: vi.fn().mockResolvedValue(false), // pet UI mounting is out of scope here
  highlightWatchRef: { current: null as ((on: boolean) => void) | null },
  defRef: { current: null as { main: (ctx: { onInvalidated: (cb: () => void) => void }) => Promise<void> } | null },
}));

vi.mock('@/components/floating-agent', () => ({
  FloatingAgent: () => null,
  // content.tsx 动态 import 后解构的是挂载入口,mock 缺了会 TypeError
  mountFloatingAgent: vi.fn(() => ({ unmount: vi.fn() })),
}));

vi.mock('@/lib/marks', () => ({
  showClip: (clip: unknown, scroll?: boolean) => mockShowClip(clip, scroll),
  clearAllMarks: () => mockClearAllMarks(),
  saveClipDraft: vi.fn(),
  restyleMarks: vi.fn(),
  pruneMarks: vi.fn(),
}));

vi.mock('@/lib/page-text', () => ({
  pageText: () => '',
}));

vi.mock('@/lib/clips-store', () => ({
  addClip: vi.fn(),
  clipsPageItem: () => ({ getValue: () => mockClipsGet(), watch: () => () => {} }),
  normalizeUrl: (u: string) => u,
}));

vi.mock('@/lib/clips-highlight', () => ({
  buildClipUrl: (u: string) => u,
}));

vi.mock('@/lib/utils', () => ({
  onPageNav: () => () => {},
}));

vi.mock('@/lib/settings', () => ({
  petEnabledItem: { getValue: () => mockPetGet(), watch: () => () => {} },
  clipHighlightItem: {
    getValue: () => mockHighlightGet(),
    watch: (cb: (on: boolean) => void) => { highlightWatchRef.current = cb; return () => {}; },
  },
  highlightColorItem: { watch: () => () => {} },
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, sendMessage: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('wxt/utils/define-content-script', () => ({
  defineContentScript: (def: unknown) => {
    defRef.current = def as NonNullable<typeof defRef.current>;
    return def;
  },
}));

vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: vi.fn().mockResolvedValue({ mount: vi.fn(), remove: vi.fn() }),
}));

vi.mock('@/assets/content.css', () => ({}));

// idle callbacks are captured, not run: each test flushes the queue by hand
const idleCallbacks: (() => void)[] = [];
vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
  idleCallbacks.push(cb);
  return idleCallbacks.length;
});

// import after mocks — registers the content script definition via the mock above
await import('@/entrypoints/content');

async function until(pred: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const clip = {
  id: 'c1',
  url: 'http://localhost:3000/#:~:text=x',
  pageUrl: 'http://localhost:3000/',
  title: 't',
  text: 'x',
  createdAt: 1,
};

describe('content main() clip highlight replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idleCallbacks.length = 0;
    highlightWatchRef.current = null;
    mockClipsGet.mockResolvedValue([clip]);
    mockHighlightGet.mockResolvedValue(true);
    mockPetGet.mockResolvedValue(false);
  });

  it('replays saved clips as in-page marks through idle callbacks', async () => {
    await defRef.current!.main({ onInvalidated: () => {} });
    await until(() => idleCallbacks.length === 1);
    idleCallbacks[0]();
    expect(mockShowClip).toHaveBeenCalledWith(clip, false); // no scroll on replay
  });

  // regression: switching the toggle off used to leave in-flight idle callbacks alive,
  // so the queued replay ran anyway and marks came back right after the user disabled
  // highlighting — clipGen must invalidate every queued callback
  it('drops queued idle replays when highlighting is switched off before they run', async () => {
    await defRef.current!.main({ onInvalidated: () => {} });
    await until(() => idleCallbacks.length === 1);

    highlightWatchRef.current?.(false); // popup toggle flips off
    expect(mockClearAllMarks).toHaveBeenCalledTimes(1);

    idleCallbacks[0](); // the stale queued callback fires anyway
    expect(mockShowClip).not.toHaveBeenCalled();

    // flipping back on starts a fresh generation whose callbacks do mark again
    highlightWatchRef.current?.(true);
    await until(() => idleCallbacks.length === 2);
    idleCallbacks[1]();
    expect(mockShowClip).toHaveBeenCalledWith(clip, false);
  });
});
