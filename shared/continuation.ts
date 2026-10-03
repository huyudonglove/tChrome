// Single source of truth for Runtime-synthesized continuation input.
//
// When a turn is force-closed by the single-turn rotation gate (its own injected
// content crossed context.turnRotateAtChars), the caller opens a new turn with a
// synthetic input built from the original user message. The prefix is what the
// sidebar and conversation previews use to tell a synthetic bubble from a real
// one, so it must never be produced anywhere else.
export const CONTINUATION_INPUT_PREFIX = "runtime:续接（压缩前用户输入）";

export function continuationInputText(originalUserInput: string): string {
  return `${CONTINUATION_INPUT_PREFIX}\n${originalUserInput}`;
}

export function isContinuationInput(text: string): boolean {
  return text.startsWith(CONTINUATION_INPUT_PREFIX);
}

export function stripContinuationPrefix(text: string): string {
  return isContinuationInput(text) ? text.slice(CONTINUATION_INPUT_PREFIX.length).replace(/^\n/, "") : text;
}
