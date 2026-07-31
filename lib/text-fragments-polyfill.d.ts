// upstream ships no types; minimal surface we use
declare module 'text-fragments-polyfill/dist/fragment-generation-utils.js' {
  export interface TextFragment {
    textStart: string;
    textEnd?: string;
    prefix?: string;
    suffix?: string;
  }
  export const GenerateFragmentStatus: {
    SUCCESS: 0;
    INVALID_SELECTION: 1;
    AMBIGUOUS: 2;
    TIMEOUT: 3;
    EXECUTION_FAILED: 4;
  };
  export function generateFragment(
    selection: Selection,
    startTime?: Date,
  ): { status: number; fragment?: TextFragment };
}

declare module 'text-fragments-polyfill/text-fragment-utils' {
  import type { TextFragment } from 'text-fragments-polyfill/dist/fragment-generation-utils.js';
  export function getFragmentDirectives(hash: string): { text?: string[] };
  export function parseFragmentDirectives(directives: { text?: string[] }): { text?: TextFragment[] };
  export function processTextFragmentDirective(
    fragment: TextFragment,
    doc?: Document,
    root?: Element,
  ): Range[];
  export function markRange(range: Range, doc?: Document): Element[];
  export function removeMarks(marks: Element[], doc?: Document): void;
}
