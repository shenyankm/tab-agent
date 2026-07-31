import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// --- hoisted mocks ---
const {
  mockThemeGet, mockThemeWatch, mockEnabledGet, mockEnabledWatch,
  mockPosGet, mockPosSet, mockCarryGet, portRef,
} = vi.hoisted(() => ({
  mockThemeGet: vi.fn().mockResolvedValue('light'),
  mockThemeWatch: vi.fn().mockReturnValue(() => {}),
  mockEnabledGet: vi.fn().mockResolvedValue(true),
  mockEnabledWatch: vi.fn().mockReturnValue(() => {}),
  mockPosGet: vi.fn().mockResolvedValue({ right: 20, bottom: 20 }),
  mockPosSet: vi.fn(),
  mockCarryGet: vi.fn().mockResolvedValue('article'),
  portRef: {
    listener: null as ((msg: unknown) => void) | null,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock('@/lib/settings', () => ({
  themeItem: { getValue: () => mockThemeGet(), watch: () => mockThemeWatch() },
  petEnabledItem: { getValue: () => mockEnabledGet(), watch: () => mockEnabledWatch() },
  petPosItem: { getValue: () => mockPosGet(), setValue: (v: unknown) => mockPosSet(v) },
  pageCarryItem: { getValue: () => mockCarryGet(), watch: () => () => {} },
  isDark: () => false,
}));

vi.mock('@/lib/i18n', () => ({
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

import { FloatingAgent } from '@/entrypoints/content';

describe('FloatingAgent', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    portRef.listener = null;
    mockEnabledGet.mockResolvedValue(true);
    mockThemeGet.mockResolvedValue('light');
    mockPosGet.mockResolvedValue({ right: 20, bottom: 20 });
    mockCarryGet.mockResolvedValue('article');
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
