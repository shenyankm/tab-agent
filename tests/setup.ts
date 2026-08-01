import '@testing-library/jest-dom/vitest';
// jsdom lacks IndexedDB (clips storage). NOTE: fake-indexeddb is single-origin, so
// it cannot reproduce the page-vs-extension origin isolation that clips avoid by
// proxying content scripts over messages — see the content-proxy test in clips.test.ts.
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// jsdom lacks matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom lacks innerText
Object.defineProperty(document.body, 'innerText', {
  configurable: true,
  get: () => '',
});

// jsdom lacks the pointer capture API
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

// jsdom lacks scrollIntoView
Element.prototype.scrollIntoView = vi.fn();
