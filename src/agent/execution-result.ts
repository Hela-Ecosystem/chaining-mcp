import { isHelaResult } from './hela-result.js';

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') {
    return value.message.trim() || undefined;
  }
  return undefined;
}

/** Read failure markers from a result and its transport envelopes. */
export function toolResultError(result: unknown): string | undefined {
  if (result instanceof Error) return errorMessage(result) ?? 'Tool reported an error';
  if (typeof result === 'string' && result.trimStart().startsWith('{')) {
    try { result = JSON.parse(result); } catch { return undefined; }
  }
  if (typeof result !== 'object' || result === null) return undefined;
  const payload = result as Record<string, unknown>;
  const detail = errorMessage(payload.error);
  if (detail) return detail;

  if ('structuredContent' in payload) {
    const error = toolResultError(payload.structuredContent);
    if (error) return error;
  }
  const textBlocks = Array.isArray(payload.content)
    ? payload.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    : [];
  for (const text of textBlocks) {
    const error = toolResultError(text);
    if (error) return error;
  }
  if (isHelaResult(payload)) {
    const error = toolResultError(payload.data);
    if (error) return error;
  }

  if (payload.success === false || payload.ok === false || payload.isError === true ||
      payload.error === true || (typeof payload.error === 'object' && payload.error !== null)) {
    return errorMessage(payload.message) ?? errorMessage(payload.summary)
      ?? (payload.isError === true ? textBlocks.map(errorMessage).find(Boolean) : undefined)
      ?? 'Tool reported an error';
  }
  return undefined;
}
