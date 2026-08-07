import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing';

// options pages had zero coverage: UI changes there never failed any test
const { mockClips, mockRemoveClip } = vi.hoisted(() => ({
  mockClips: vi.fn(),
  mockRemoveClip: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/clips-store', () => ({
  getClipsDirect: () => mockClips(),
  getClipsPageDirect: () => mockClips().then((clips: unknown[]) => ({ clips, total: clips.length })),
  getClipCategoriesDirect: () => mockClips().then((clips: { category?: string }[]) =>
    [...new Set(clips.map((c) => c.category).filter((v): v is string => !!v))].sort()),
  removeClip: (id: string) => mockRemoveClip(id),
  updateClip: vi.fn().mockResolvedValue(undefined),
  clipNavUrl: (c: { pageUrl: string; id: string }) => `${c.pageUrl}#tab-agent-clip=${c.id}`,
}));

// t() returns the key: assertions read the raw keys
vi.mock('@/lib/i18n', () => ({
  dict: {},
  useI18n: () => ({ t: (k: string) => k }),
}));

import ClipsPage from '@/entrypoints/options/pages/clips';

const clip = {
  id: 'a',
  url: 'https://e.com/p#:~:text=hello',
  pageUrl: 'https://e.com/p',
  title: 'T',
  text: 'hello world',
  createdAt: 1,
};

describe('ClipsPage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    mockClips.mockResolvedValue([clip]);
    mockRemoveClip.mockClear();
  });
  afterEach(cleanup);

  it('lists clips with title and text', async () => {
    render(<ClipsPage />);
    expect(await screen.findByText('hello world')).toBeInTheDocument();
    expect(screen.getByText(/T · https:\/\/e\.com\/p/)).toBeInTheDocument();
  });

  it('row menu delete confirms via dialog, then removes', async () => {
    render(<ClipsPage />);
    const trigger = await screen.findByLabelText('clips.moreActions');
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByRole('menuitem', { name: 'clips.delete' }));

    // confirmation dialog, not an instant delete
    expect(mockRemoveClip).not.toHaveBeenCalled();
    expect(screen.getByText('clips.confirmDelete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'clips.delete' }));
    await waitFor(() => expect(mockRemoveClip).toHaveBeenCalledWith('a'));
  });

  it('row menu cancel keeps the clip', async () => {
    render(<ClipsPage />);
    const trigger = await screen.findByLabelText('clips.moreActions');
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'clips.delete' }));

    fireEvent.click(screen.getByRole('button', { name: 'clips.cancel' }));
    await waitFor(() => expect(screen.queryByText('clips.confirmDelete')).not.toBeInTheDocument());
    expect(mockRemoveClip).not.toHaveBeenCalled();
  });
});
