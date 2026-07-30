import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// vi.hoisted ensures these exist before the hoisted vi.mock factory runs
const { mockGetValue, mockWatch, mockSetValue } = vi.hoisted(() => ({
  mockGetValue: vi.fn().mockResolvedValue('en'),
  mockWatch: vi.fn().mockReturnValue(() => {}),
  mockSetValue: vi.fn(),
}));

vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: () => ({ getValue: mockGetValue, watch: mockWatch, setValue: mockSetValue }),
  },
}));

import { useI18n } from '@/lib/i18n';

describe('useI18n t()', () => {
  beforeEach(() => {
    mockGetValue.mockResolvedValue('en');
  });

  it('looks up a key in the dictionary', async () => {
    const { result } = renderHook(() => useI18n());
    await waitFor(() => expect(result.current.t('settings.title')).toBe('Settings'));
  });

  it('interpolates variables', async () => {
    const { result } = renderHook(() => useI18n());
    await waitFor(() =>
      expect(result.current.t('widget.error.generic', { message: 'oops' })).toBe('Request failed: oops'),
    );
  });

  it('falls back to the key itself for missing entries', async () => {
    const { result } = renderHook(() => useI18n());
    await waitFor(() => expect(result.current.t('nonexistent.key')).toBe('nonexistent.key'));
  });

  it('returns zh-CN translations when lang is zh-CN', async () => {
    mockGetValue.mockResolvedValue('zh-CN');
    const { result } = renderHook(() => useI18n());
    await waitFor(() => expect(result.current.t('settings.title')).toBe('设置'));
  });
});
