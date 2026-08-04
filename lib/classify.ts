// Clips batch classification: prompt one batch of clips through the cloud agent
// (via gateway handleChat) and parse the JSON reply into patches. The write-back
// orchestrator (handleClassify) stays in the entrypoint — it needs
// fanOutClipsChanged, and importing that from here would be circular.
import { handleChat, type ChatOut } from '@/lib/gateway';
import type { Clip } from '@/lib/clips-store';

// one prompt per batch: a single all-clips prompt grows linearly in input and
// O(N²) in output (relatedIds), truncating the JSON reply and voiding the whole run
const CLASSIFY_BATCH = 50;

/** Parse the agent's JSON reply into sanitized patches for this batch's ids. */
function parseClassifyPatches(full: string, ids: Set<string>) {
  // extract JSON: try direct parse, then try stripping markdown fences
  let parsed: unknown;
  try {
    parsed = JSON.parse(full);
  } catch {
    const m = full.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in agent reply');
    parsed = JSON.parse(m[0]);
  }
  const items = (parsed as { clips?: unknown })?.clips;
  if (!Array.isArray(items)) throw new Error('agent reply missing clips array');

  const patches: { id: string; patch: { category: string; relatedIds: string[]; tags?: string[] } }[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.category !== 'string') continue;
    if (!ids.has(item.id)) continue;
    patches.push({
      id: item.id,
      patch: {
        category: item.category,
        relatedIds: Array.isArray(item.relatedIds)
          ? item.relatedIds.filter((rid: unknown) => typeof rid === 'string' && ids.has(rid))
          : [],
        // tags are AI-generated; absent in the reply = leave untouched
        ...(Array.isArray(item.tags)
          ? { tags: item.tags.filter((tag: unknown) => typeof tag === 'string') }
          : {}),
      },
    });
  }
  return patches;
}

/** Send one batch to the cloud agent and collect the full reply; one retry on an
 *  unparseable reply. Uses a dedicated session so classify never cancels/pollutes
 *  the user's chat session. ponytail: relations never cross batches — the model
 *  only sees its own batch, so relatedIds stay batch-local. */
export async function classifyBatch(clips: Clip[]) {
  const ids = new Set(clips.map((c) => c.id)); // O(1) membership below (was O(N) per id)
  const clipList = clips
    .map((c) => `- id: ${c.id}\n  text: ${c.text.slice(0, 500)}`)
    .join('\n');

  const prompt = `Classify the following text clips into knowledge types and identify relationships between them.

Return ONLY a JSON object (no markdown fences) with this exact structure:
{"clips":[{"id":"<clip id>","category":"<knowledge type>","relatedIds":["<other clip id>",...],"tags":["<keyword>",...]}]}

Rules:
- Every clip must have exactly one category
- relatedIds lists clips that are topically related (can be empty)
- tags: up to 3 short topical keywords (can be empty)
- Use consistent category names across clips
- Return nothing except the JSON object

Clips:
${clipList}`;

  for (let attempt = 0; ; attempt++) {
    // collect the full agent reply via the send callback
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const send = (msg: ChatOut) => {
        if (msg.type === 'delta') chunks.push(msg.text);
        else if (msg.type === 'done') resolve();
        else if (msg.type === 'error') reject(new Error(msg.message ?? msg.code ?? 'classify error'));
      };
      handleChat(prompt, undefined, false, new AbortController().signal, send, '').catch(reject);
    });
    await done;
    try {
      return parseClassifyPatches(chunks.join(''), ids);
    } catch (e) {
      if (attempt === 1) throw e; // one retry, then surface the failure
    }
  }
}

export { CLASSIFY_BATCH };
