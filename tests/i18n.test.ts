import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { contentDict } from '@/lib/i18n-content';

// key 缺失由 lib/i18n.ts 的 satisfies 类型在 tsc 阶段报错,这里只查 tsc 管不到的占位符
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

// contentDict 是 content bundle 的瘦身字典:值必须与完整 dict 一致,
// 否则页面语言与 popup/options 语言漂移;新增 key 忘了同步在这里失败
describe('contentDict consistency', () => {
  it('matches the full dict for every key and language', () => {
    for (const lang of Object.keys(contentDict) as (keyof typeof contentDict)[]) {
      for (const [key, value] of Object.entries(contentDict[lang]))
        expect(dict[lang][key as I18nKey], `${lang} ${key}`).toBe(value);
    }
  });

  // 反向守护:content UI 树(FloatingAgent/ChatPanel/ClipDraftEditor)实际用到的
  // t() key 必须全部收录在 contentDict,否则组件文案静默显示裸 key
  it('covers every t() key used by the content UI tree', () => {
    const files = [
      'components/floating-agent.tsx',
      'components/agent/ChatPanel.tsx',
      'components/agent/ClipDraftEditor.tsx',
    ];
    const keys = new Set<string>();
    for (const f of files) {
      const src = readFileSync(resolve(import.meta.dirname, '..', f), 'utf8');
      for (const m of src.matchAll(/\bt\(['"]([^'"]+)['"]/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(10); // sanity: the scan actually finds keys
    for (const k of keys) expect(contentDict.en, `missing in contentDict: ${k}`).toHaveProperty(k);
  });
});

describe('useI18n t()', () => {
  beforeEach(() => {
    mockGetValue.mockResolvedValue('en');
  });

  it('looks up a key in the dictionary', async () => {
    const { result } = renderHook(() => useI18n(dict));
    await waitFor(() => expect(result.current.t('settings.language')).toBe('Language'));
  });

  it('interpolates variables', async () => {
    const { result } = renderHook(() => useI18n(dict));
    await waitFor(() =>
      expect(result.current.t('widget.translate', { text: 'hello' })).toBe('Translate into English: hello'),
    );
  });

  it('falls back to the key itself for missing entries', async () => {
    const { result } = renderHook(() => useI18n(dict));
    // cast: intentionally probes an out-of-dictionary key
    await waitFor(() => expect(result.current.t('nonexistent.key' as I18nKey)).toBe('nonexistent.key'));
  });

  it('returns zh-CN translations when lang is zh-CN', async () => {
    mockGetValue.mockResolvedValue('zh-CN');
    const { result } = renderHook(() => useI18n(dict));
    await waitFor(() => expect(result.current.t('settings.language')).toBe('显示语言'));
  });

  it('falls back to the default-lang dict for keys missing from a subset dict', async () => {
    mockGetValue.mockResolvedValue('en');
    const { result } = renderHook(() => useI18n(contentDict));
    // contentDict has no settings.language: falls back to contentDict[zh-CN]…
    await waitFor(() => expect(result.current.t('settings.language' as I18nKey)).toBe('settings.language'));
    // …and a present key resolves normally
    await waitFor(() => expect(result.current.t('widget.greeting')).toBe('Hi! What would you like to know about this page?'));
  });
});
