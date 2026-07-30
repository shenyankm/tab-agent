import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDark } from '@/lib/settings';

describe('isDark', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns true for dark theme', () => {
    expect(isDark('dark')).toBe(true);
  });

  it('returns false for light theme', () => {
    expect(isDark('light')).toBe(false);
  });

  it('returns true for system theme when prefers-color-scheme is dark', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    expect(isDark('system')).toBe(true);
  });

  it('returns false for system theme when prefers-color-scheme is light', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
    expect(isDark('system')).toBe(false);
  });
});
