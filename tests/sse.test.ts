import { describe, it, expect } from 'vitest';
import { parseSSE } from '@/lib/sse';

describe('parseSSE', () => {
  it('returns empty data and rest for empty string', () => {
    expect(parseSSE('')).toEqual({ data: [], rest: '' });
  });

  it('preserves incomplete frame as rest', () => {
    expect(parseSSE('data: {"a"')).toEqual({ data: [], rest: 'data: {"a"' });
  });

  it('parses frame completed across chunks', () => {
    const r = parseSSE('data: {"a":1}\n\n');
    expect(r).toEqual({ data: ['{"a":1}'], rest: '' });
  });

  it('ignores heartbeat comment frames', () => {
    expect(parseSSE(': heartbeat\n\n')).toEqual({ data: [], rest: '' });
  });

  it('joins multi data-line frames with newline', () => {
    const r = parseSSE('id: 1\ndata: line1\ndata: line2\n\n');
    expect(r).toEqual({ data: ['line1\nline2'], rest: '' });
  });

  it('consumes complete frame and preserves trailing partial', () => {
    const r = parseSSE('data: full\n\ndata: partial');
    expect(r).toEqual({ data: ['full'], rest: 'data: partial' });
  });

  it('parses multiple consecutive complete frames', () => {
    const r = parseSSE('data: one\n\ndata: two\n\ndata: three\n\n');
    expect(r).toEqual({ data: ['one', 'two', 'three'], rest: '' });
  });

  it('strips data: without leading space', () => {
    const r = parseSSE('data:nospace\n\n');
    expect(r).toEqual({ data: ['nospace'], rest: '' });
  });

  it('ignores frames with only id/event lines and no data', () => {
    const r = parseSSE('id: 42\nevent: ping\n\n');
    expect(r).toEqual({ data: [], rest: '' });
  });

  it('normalizes CRLF line endings', () => {
    const r = parseSSE('data: a\r\ndata: b\r\n\r\n');
    expect(r).toEqual({ data: ['a\nb'], rest: '' });
  });

  it('normalizes CRLF frames split across reads', () => {
    // streamReply concatenates chunk + buffer before parsing, so a lone \r ending
    // one read and \n starting the next still normalize into one \r\n
    const r1 = parseSSE('data: a\r');
    const r2 = parseSSE(r1.rest + '\n\r\n');
    expect(r2).toEqual({ data: ['a'], rest: '' });
  });
});
