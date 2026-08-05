import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// --- hoisted mocks ---
const { mockPermRequest, mockPermContains, mockPermRemove, mockCarrySet, carryRef } = vi.hoisted(() => ({
  mockPermRequest: vi.fn(),
  mockPermContains: vi.fn(),
  mockPermRemove: vi.fn(),
  mockCarrySet: vi.fn(),
  carryRef: { current: 'article' as string },
}));

vi.mock('@/lib/settings', () => ({
  petEnabledItem: { getValue: () => Promise.resolve(true), watch: () => () => {}, setValue: vi.fn() },
  pageCarryItem: {
    getValue: () => Promise.resolve(carryRef.current),
    watch: () => () => {},
    setValue: (v: string) => mockCarrySet(v),
  },
  clipHighlightItem: { getValue: () => Promise.resolve(true), watch: () => () => {}, setValue: vi.fn() },
}));

// t() returns the key: assertions read the raw keys
vi.mock('@/lib/i18n', () => ({
  dict: {},
  useI18n: () => ({ t: (k: string) => k }),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    permissions: {
      request: (p: unknown) => mockPermRequest(p),
      contains: (p: unknown) => mockPermContains(p),
      remove: (p: unknown) => mockPermRemove(p),
    },
    runtime: { openOptionsPage: vi.fn() },
  },
}));

import App from '@/entrypoints/popup/App';

// open the carry dropdown (starts from `from`, the 'article' default) and pick an option
async function pickCarry(label: string, from = 'carry.article') {
  const trigger = await screen.findByRole('button', { name: from });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitemradio', { name: label }));
}

describe('popup screenshot permission flow', () => {
  beforeEach(() => {
    mockPermRequest.mockReset();
    mockPermContains.mockReset().mockResolvedValue(true); // default: grant intact, no mount correction
    mockPermRemove.mockReset().mockResolvedValue(undefined);
    mockCarrySet.mockReset();
    carryRef.current = 'article';
  });
  afterEach(cleanup);

  it('asks for <all_urls> inside the click and saves screenshot when granted', async () => {
    mockPermRequest.mockResolvedValue(true);
    render(<App />);
    await pickCarry('carry.screenshot');

    await waitFor(() => expect(mockPermRequest).toHaveBeenCalledWith({ origins: ['<all_urls>'] }));
    await waitFor(() => expect(mockCarrySet).toHaveBeenCalledWith('screenshot'));
  });

  it('keeps the previous carry and saves nothing when the user denies the permission', async () => {
    mockPermRequest.mockResolvedValue(false);
    render(<App />);
    await pickCarry('carry.screenshot');

    await waitFor(() => expect(mockPermRequest).toHaveBeenCalledWith({ origins: ['<all_urls>'] }));
    await act(async () => {}); // let the denied continuation settle
    expect(mockCarrySet).not.toHaveBeenCalled();
    // the dropdown still shows the old value
    expect(screen.getByRole('button', { name: 'carry.article' })).toBeInTheDocument();
  });

  it('corrects a stored screenshot carry on mount when the grant was revoked', async () => {
    mockPermContains.mockResolvedValue(false);
    carryRef.current = 'screenshot';
    render(<App />);

    await waitFor(() => expect(mockCarrySet).toHaveBeenCalledWith('article'));
  });

  it('releases <all_urls> when switching away from screenshot', async () => {
    carryRef.current = 'screenshot';
    render(<App />);
    await pickCarry('carry.none', 'carry.screenshot');

    await waitFor(() => expect(mockPermRemove).toHaveBeenCalledWith({ origins: ['<all_urls>'] }));
    await waitFor(() => expect(mockCarrySet).toHaveBeenCalledWith('none'));
    expect(mockPermRequest).not.toHaveBeenCalled();
  });
});
