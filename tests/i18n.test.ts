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

import { useI18n, dict } from '@/lib/i18n';

describe('dict parity', () => {
  const base = Object.keys(dict.en).sort();

  it('every language has exactly the same keys as en', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'ja'] as const) {
      expect(Object.keys(dict[lang]).sort()).toEqual(base);
    }
  });

  it('placeholders survive translation', () => {
    for (const key of base) {
      const holders = (dict.en[key].match(/\{\w+\}/g) ?? []).sort();
      for (const lang of ['zh-CN', 'zh-TW', 'ja'] as const) {
        expect((dict[lang][key].match(/\{\w+\}/g) ?? []).sort(), `${lang} ${key}`).toEqual(holders);
      }
    }
  });
});

describe('useI18n t()', () => {
  beforeEach(() => {
    mockGetValue.mockResolvedValue('en');
  });

  it('looks up a key in the dictionary', async () => {
    const { result } = renderHook(() => useI18n());
    await waitFor(() => expect(result.current.t('settings.language')).toBe('Language'));
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
    await waitFor(() => expect(result.current.t('settings.language')).toBe('显示语言'));
  });
});
