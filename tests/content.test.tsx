import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// --- hoisted mocks ---
const {
  mockThemeGet, mockThemeWatch, mockEnabledGet, mockEnabledWatch,
  mockPosGet, mockPosSet, mockCarryGet, mockClipsGet, mockRemoveClip, mockHighlightClip,
  mockHighlightOn, mockRemoveMarks, portRef,
} = vi.hoisted(() => ({
  mockThemeGet: vi.fn().mockResolvedValue('light'),
  mockThemeWatch: vi.fn().mockReturnValue(() => {}),
  mockEnabledGet: vi.fn().mockResolvedValue(true),
  mockEnabledWatch: vi.fn().mockReturnValue(() => {}),
  mockPosGet: vi.fn().mockResolvedValue({ right: 20, bottom: 20 }),
  mockPosSet: vi.fn(),
  mockCarryGet: vi.fn().mockResolvedValue('article'),
  mockClipsGet: vi.fn().mockResolvedValue([]),
  mockRemoveClip: vi.fn(),
  mockHighlightClip: vi.fn(),
  mockHighlightOn: vi.fn().mockResolvedValue(true),
  mockRemoveMarks: vi.fn(),
  portRef: {
    listener: null as ((msg: unknown) => void) | null,
    disconnectListener: null as (() => void) | null,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock('@/lib/settings', () => ({
  themeItem: { getValue: () => mockThemeGet(), watch: () => mockThemeWatch() },
  petEnabledItem: { getValue: () => mockEnabledGet(), watch: () => mockEnabledWatch() },
  petPosItem: { getValue: () => mockPosGet(), setValue: (v: unknown) => mockPosSet(v) },
  pageCarryItem: { getValue: () => mockCarryGet(), watch: () => () => {} },
  clipHighlightItem: { getValue: () => mockHighlightOn(), watch: () => () => {} },
  isDark: () => false,
}));

vi.mock('@/lib/clips', () => {
  const normalize = (u: string) => { try { const p = new URL(u); p.hash = ''; return p.toString(); } catch { return u; } };
  // stable item per page: useStorageValue keys its effect on item identity
  const pageItems = new Map<string, { getValue: () => Promise<unknown[]>; watch: () => () => void }>();
  return {
    clipsPageItem: (page: string) => {
      let item = pageItems.get(page);
      if (!item) {
        item = {
          // background 只回本页摘录:mock 同样按 page 过滤
          getValue: () => mockClipsGet().then((clips: { pageUrl: string }[]) =>
            clips.filter((c) => normalize(c.pageUrl) === page)),
          watch: () => () => {},
        };
        pageItems.set(page, item);
      }
      return item;
    },
    addClip: vi.fn(),
    buildClipUrl: vi.fn(),
    normalizeUrl: normalize,
    removeClip: (id: string) => mockRemoveClip(id),
    highlightClip: (clip: unknown) => mockHighlightClip(clip),
    // IMG outline reset + removeMarks under one roof; tests only exercise marks
    unhighlightClip: (els: unknown) => mockRemoveMarks(els),
    removeMarks: (marks: unknown) => mockRemoveMarks(marks),
    clipNavUrl: (clip: { pageUrl: string; id: string }) => `${clip.pageUrl.split('#')[0]}#pixel-agent-clip=${clip.id}`,
  };
});

vi.mock('@/lib/i18n', () => ({
  langItem: { getValue: () => Promise.resolve('en') },
  useI18n: () => ({
    lang: 'en',
    setLang: vi.fn(),
    t: (key: string, vars?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'widget.open': 'Open Pixel Agent',
        'widget.close': 'Close Pixel Agent',
        'widget.greeting': 'Hi! What would you like to know about this page?',
        'widget.placeholder': 'Ask about this page…',
        'widget.send': 'Send',
        'widget.status.thinking': 'Thinking',
        'widget.error.unconfigured': 'Not configured.',
        'widget.error.auth': 'API token invalid.',
        'widget.error.generic': 'Request failed: {message}',
        'widget.error.disconnected': 'Connection lost.',
        'widget.translate': 'Translate into English: {text}',
        'widget.tab.chat': 'Chat',
        'nav.clips': 'Clips',
        'clips.empty': 'No clips yet.',
        'clips.delete': 'Delete clip',
        'clips.editor.heading': 'Edit before saving',
        'clips.editor.title': 'Title',
        'clips.notePlaceholder': 'Add notes (one per line)…',
        'clips.save': 'Save',
        'clips.cancel': 'Cancel',
      };
      let s = dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
  }),
}));

// mock WXT browser module (auto-import target)
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      connect: () => ({
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => { portRef.listener = fn; },
        },
        onDisconnect: {
          addListener: (fn: () => void) => { portRef.disconnectListener = fn; },
        },
        postMessage: portRef.postMessage,
        disconnect: portRef.disconnect,
      }),
      getURL: (path: string) => `chrome-extension://test${path}`,
    },
  },
}));

// mock content script registration (module-level code in content.tsx)
vi.mock('wxt/utils/define-content-script', () => ({
  defineContentScript: (def: unknown) => def,
}));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: () => ({ mount: vi.fn() }),
}));

import { FloatingAgent, saveClipDraft } from '@/components/floating-agent';
import { addClip, type Clip } from '@/lib/clips';

describe('FloatingAgent', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    portRef.listener = null;
    portRef.disconnectListener = null;
    mockEnabledGet.mockResolvedValue(true);
    mockThemeGet.mockResolvedValue('light');
    mockPosGet.mockResolvedValue({ right: 20, bottom: 20 });
    mockCarryGet.mockResolvedValue('article');
    mockClipsGet.mockResolvedValue([]);
    mockHighlightOn.mockResolvedValue(true);
    mockHighlightClip.mockImplementation(() => [document.createElement('mark')]);
  });

  it('renders nothing when pet is disabled', async () => {
    mockEnabledGet.mockResolvedValue(false);
    const { container } = render(<FloatingAgent />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('opens panel on launcher click and shows greeting', async () => {
    render(<FloatingAgent />);
    const launcher = await screen.findByRole('button', { name: 'Open Pixel Agent' });
    fireEvent.click(launcher);
    expect(await screen.findByText('Hi! What would you like to know about this page?')).toBeInTheDocument();
  });

  it('sends message via port and shows user bubble', async () => {
    render(<FloatingAgent />);
    const launcher = await screen.findByRole('button', { name: 'Open Pixel Agent' });
    fireEvent.click(launcher);

    const input = await screen.findByPlaceholderText('Ask about this page…');
    fireEvent.change(input, { target: { value: 'What is this?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('What is this?')).toBeInTheDocument();
    expect(portRef.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'What is this?' }),
    );
  });

  it('sends screenshot flag and no page text in screenshot mode', async () => {
    mockCarryGet.mockResolvedValue('screenshot');
    render(<FloatingAgent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pixel Agent' }));

    const input = await screen.findByPlaceholderText('Ask about this page…');
    fireEvent.change(input, { target: { value: 'what do you see?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(portRef.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshot: true,
          page: expect.objectContaining({ text: '' }),
        }),
      );
    });
  });

  it('appends streamed delta text to agent bubble', async () => {
    render(<FloatingAgent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pixel Agent' }));

    const input = await screen.findByPlaceholderText('Ask about this page…');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    act(() => {
      portRef.listener?.({ type: 'delta', text: 'Hello ' });
      portRef.listener?.({ type: 'delta', text: 'world' });
      portRef.listener?.({ type: 'done' });
    });

    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());
    // send + receive timestamps rendered under both bubbles
    expect(screen.getAllByText(/\d{1,2}:\d{2}:\d{2}/)).toHaveLength(2);
  });

  it('clips tab lists only clips saved on the current page', async () => {
    mockClipsGet.mockResolvedValue([
      { id: '1', url: 'http://localhost:3000/#:~:text=here', pageUrl: 'http://localhost:3000/', title: 't', text: 'clip on this page', createdAt: 1 },
      { id: '2', url: 'https://other.com/#:~:text=x', pageUrl: 'https://other.com/', title: 'o', text: 'clip elsewhere', createdAt: 2 },
    ]);
    render(<FloatingAgent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pixel Agent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clips' }));

    expect(await screen.findByText('clip on this page')).toBeInTheDocument();
    expect(screen.queryByText('clip elsewhere')).not.toBeInTheDocument();
    // chat input is hidden on the clips tab
    expect(screen.queryByPlaceholderText('Ask about this page…')).not.toBeInTheDocument();

    // clicking an item re-highlights in-page (no new tab)
    fireEvent.click(screen.getByText('clip on this page'));
    expect(mockHighlightClip).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));

    // management lives in the options page: no delete button in the widget
    expect(screen.queryByRole('button', { name: 'Delete clip' })).not.toBeInTheDocument();
  });

  it('saveClipDraft pops the edit card; saving commits edited title/notes', async () => {
    vi.mocked(addClip).mockResolvedValue({ id: 'c1', createdAt: 1 } as unknown as Clip);
    render(<FloatingAgent />);
    await screen.findByRole('button', { name: 'Open Pixel Agent' });

    // panel closed — the card still pops
    act(() => saveClipDraft({ url: 'http://localhost/', pageUrl: 'http://localhost/', title: 'Page', text: 'selected words' }));
    expect(await screen.findByText('Edit before saving')).toBeInTheDocument();
    expect(screen.getByText('selected words')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } });
    fireEvent.change(screen.getByPlaceholderText('Add notes (one per line)…'), { target: { value: 'note one\n\nnote two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(addClip).toHaveBeenCalledWith(expect.objectContaining({
      text: 'selected words',
      title: 'My title',
      notes: ['note one', 'note two'],
    }));
    await waitFor(() => expect(screen.queryByText('Edit before saving')).not.toBeInTheDocument());
  });

  it('pre-fills a translate prompt from the page selection, capped at 2k chars', async () => {
    const node = document.body.appendChild(document.createTextNode('x'.repeat(3000)));
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    render(<FloatingAgent />);
    const launcher = await screen.findByRole('button', { name: 'Open Pixel Agent' });
    // selection is captured at pointerdown (the click itself collapses it)
    fireEvent.pointerDown(launcher, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(launcher, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.click(launcher);

    const input = await screen.findByPlaceholderText('Ask about this page…') as HTMLInputElement;
    expect(input.value).toBe(`Translate into English: ${'x'.repeat(2000)}`);

    sel.removeAllRanges();
    node.remove();
  });

  it('fades the located marks out when highlighting is off', async () => {
    mockHighlightOn.mockResolvedValue(false);
    mockClipsGet.mockResolvedValue([
      { id: '9', url: 'http://localhost:3000/#:~:text=here', pageUrl: 'http://localhost:3000/', title: 't', text: 'flash me', createdAt: 1 },
    ]);
    render(<FloatingAgent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pixel Agent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clips' }));
    await screen.findByText('flash me');

    vi.useFakeTimers();
    fireEvent.click(screen.getByText('flash me'));
    await vi.advanceTimersByTimeAsync(3100);
    vi.useRealTimers();
    expect(mockRemoveMarks).toHaveBeenCalled();
  });

  it('shows unconfigured error message', async () => {
    render(<FloatingAgent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pixel Agent' }));

    const input = await screen.findByPlaceholderText('Ask about this page…');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    act(() => {
      portRef.listener?.({ type: 'error', code: 'unconfigured' });
    });

    await waitFor(() => expect(screen.getByText('Not configured.')).toBeInTheDocument());
  });

  // regression: MV3 killed the background worker mid-turn (long screenshot turns) and
  // the widget hung on "Thinking…" forever because port death was never handled
  it('shows disconnected error when port dies mid-turn, not after done', async () => {
    render(<FloatingAgent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pixel Agent' }));

    const input = await screen.findByPlaceholderText('Ask about this page…');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    act(() => portRef.disconnectListener?.());
    await waitFor(() => expect(screen.getByText('Connection lost.')).toBeInTheDocument());

    // settled turn: a later disconnect must not overwrite the answer
    fireEvent.change(input, { target: { value: 'hi again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => {
      portRef.listener?.({ type: 'delta', text: 'Answer' });
      portRef.listener?.({ type: 'done' });
      portRef.disconnectListener?.();
    });
    await waitFor(() => expect(screen.getByText('Answer')).toBeInTheDocument());
  });

  // regression: a dropped pointerup (pointercancel) used to leave the drag ref set, so the
  // pet chased the cursor on plain hover and every later click was swallowed as "a drag"
  it('recovers from pointercancel: no hover drag, click still opens', async () => {
    render(<FloatingAgent />);
    const launcher = await screen.findByRole('button', { name: 'Open Pixel Agent' });
    const shell = launcher.parentElement!;

    fireEvent.pointerDown(launcher, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerCancel(launcher, { clientX: 100, clientY: 100, pointerId: 1 });

    // plain hover far away must not move the pet
    const before = shell.getAttribute('style');
    fireEvent.pointerMove(launcher, { clientX: 400, clientY: 400, pointerId: 1 });
    expect(shell.getAttribute('style')).toBe(before);

    // ...but a held-button drag still does
    fireEvent.pointerDown(launcher, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(launcher, { clientX: 70, clientY: 70, pointerId: 2, buttons: 1 });
    expect(shell.getAttribute('style')).not.toBe(before);
    fireEvent.pointerUp(launcher, { clientX: 70, clientY: 70, pointerId: 2 });

    fireEvent.pointerDown(launcher, { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerUp(launcher, { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.click(launcher);

    expect(await screen.findByText('Hi! What would you like to know about this page?')).toBeInTheDocument();
  });
});
