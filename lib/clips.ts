// Compatibility facade: the clips module is split into clips-store (IndexedDB +
// message facade + URL utils, no DOM deps — safe for background/options bundles)
// and clips-highlight (text-fragment generation + on-page marking, content
// script only). Existing imports from '@/lib/clips' keep working; new code in
// background/options should import from '@/lib/clips-store' so the
// text-fragments polyfill stays out of their bundles.
export * from './clips-store';
export * from './clips-highlight';
