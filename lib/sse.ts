// Pure SSE frame splitter — covered by tests/sse.test.ts.

/** Cut complete SSE frames out of `buffer`; returns each frame's joined data payload and the unconsumed tail. */
export function parseSSE(buffer: string): { data: string[]; rest: string } {
  const data: string[] = [];
  let rest = buffer;
  let sep;
  while ((sep = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const lines = frame.split('\n').filter((l) => l.startsWith('data:'));
    if (!lines.length) continue; // heartbeat comment or empty frame
    // per SSE spec: strip "data:" plus one optional leading space, join multi-line data with \n
    data.push(lines.map((l) => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n'));
  }
  return { data, rest };
}
