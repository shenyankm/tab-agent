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

import { useI18n, dict, type I18nKey } from '@/lib/i18n';

// key 缺失由 lib/i18n.ts 的 _parity 类型在 tsc 阶段报错,这里只查 tsc 管不到的占位符
describe('dict placeholders', () => {
  it('placeholders survive translation', () => {
    const base = Object.keys(dict.en).sort();
    const enDict: Record<string, string> = dict.en;
    for (const key of base) {
      const holders = (enDict[key].match(/\{\w+\}/g) ?? []).sort();
      for (const lang of ['zh-CN', 'zh-TW', 'ja'] as const) {
        const langDict: Record<string, string> = dict[lang];
        expect((langDict[key].match(/\{\w+\}/g) ?? []).sort(), `${lang} ${key}`).toEqual(holders);
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
    // cast: intentionally probes an out-of-dictionary key
    await waitFor(() => expect(result.current.t('nonexistent.key' as I18nKey)).toBe('nonexistent.key'));
  });

  it('returns zh-CN translations when lang is zh-CN', async () => {
    mockGetValue.mockResolvedValue('zh-CN');
    const { result } = renderHook(() => useI18n());
    await waitFor(() => expect(result.current.t('settings.language')).toBe('显示语言'));
  });
});
