// Generic helpers that aren't tied to any agent or feature in particular.

import type { ModelMessage } from "ai";

/** Short, sortable, collision-resistant id for state records. */
export function rid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Truncate a long string with a visible "[…truncated]" marker. */
export function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[…truncated]`;
}

/** Validate a URL and return it normalised; throw on garbage input. */
export function safeUrl(input: string): string {
  try {
    return new URL(input).toString();
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
}

/**
 * The AI SDK's `downloadAssets` step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
export function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}
