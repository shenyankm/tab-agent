// Self-check for lib/sse.ts — run with `node scripts/sse-check.ts` (needs Node >= 22.18 for native TS type stripping).
import assert from 'node:assert/strict';
import { parseSSE } from '../lib/sse.ts';

// 1. frame split across chunks
let r = parseSSE('data: {"a"');
assert.deepEqual(r, { data: [], rest: 'data: {"a"' });
r = parseSSE(r.rest + ':1}\n\n');
assert.deepEqual(r, { data: ['{"a":1}'], rest: '' });

// 2. heartbeat comment frame yields no data
r = parseSSE(': heartbeat\n\n');
assert.deepEqual(r, { data: [], rest: '' });

// 3. multi data-line frame joins with \n
r = parseSSE('id: 1\ndata: line1\ndata: line2\n\n');
assert.deepEqual(r, { data: ['line1\nline2'], rest: '' });

// 4. complete frame consumed, trailing partial frame preserved
r = parseSSE('data: full\n\ndata: partial');
assert.deepEqual(r, { data: ['full'], rest: 'data: partial' });

console.log('sse-check OK');
