// Email helpers used by `ResearchAgent.onEmail`. The agent file should
// only orchestrate the flow; the parsing, classification, and message
// construction live here so each step on the agent reads like prose.

import { isAutoReplyEmail } from "agents/email";
import type { UIMessage } from "ai";
import { marked } from "marked";
import type { Email as ParsedEmail } from "postal-mime";

import type { EmailMessageMeta } from "./types";
import { rid } from "./utils";

/** Display name used in the From: header of all outbound mail. */
export const EMAIL_FRIENDLY_NAME = "Research Agent";

/**
 * Inline CSS for the HTML email body. Kept minimal but enough to make
 * tables, code blocks, blockquotes, and embedded images look right
 * across Gmail/Apple Mail/Outlook (which strip <link> tags and most
 * external CSS).
 */
const EMAIL_HTML_STYLE = `
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         color: #1f2937; max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 1.6rem; line-height: 1.2; margin-top: 0; }
  h2 { font-size: 1.2rem; margin-top: 1.8em; border-bottom: 1px solid #e5e7eb; padding-bottom: .25em; }
  h3 { font-size: 1.05rem; margin-top: 1.4em; }
  img { max-width: 100%; height: auto; border-radius: 6px; margin: 12px 0; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  th { background: #f9fafb; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 13px; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d1d5db; margin: 1em 0; padding: 4px 12px; color: #4b5563; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  sup a { text-decoration: none; color: #2563eb; }
`.trim();

// ── Inbound parsing ──────────────────────────────────────────────────

/**
 * True when the email is an auto-generated message (vacation responder,
 * bounce, mailing list, etc.). Drop these to avoid mail loops.
 */
export function isAutoReply(parsed: ParsedEmail): boolean {
  const headers = (parsed.headers ?? []).map((h) => ({
    key: String(h.key ?? "").toLowerCase(),
    value: String(h.value ?? "")
  }));
  return isAutoReplyEmail(headers);
}

/**
 * Resolve the address we should reply to, in the order mail clients use:
 * Reply-To header > From header > envelope MAIL FROM. Returns `null` if
 * none are usable (caller should reject the inbound message).
 */
export function extractSender(
  parsed: ParsedEmail,
  envelopeFrom: string | undefined
): string | null {
  return (
    parsed.replyTo?.[0]?.address?.trim() ||
    parsed.from?.address?.trim() ||
    envelopeFrom?.trim() ||
    null
  );
}

/** Combine the subject and plain-text body into the question to research. */
export function extractQuestion(parsed: ParsedEmail): string {
  const subject = (parsed.subject ?? "").trim();
  const body = (parsed.text ?? "").trim();
  return [subject, body].filter(Boolean).join("\n\n").trim();
}

/** Build a "Re: …" subject line, falling back when the original was empty. */
export function formatReplySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re: Your research request";
  return s.toLowerCase().startsWith("re:") ? s : `Re: ${s}`;
}

// ── Body builders ────────────────────────────────────────────────────

/** Plain-text body for the immediate ack reply. */
export function buildAckBody(subject: string, question: string): string {
  const summary = subject || question.slice(0, 120);
  return `Hi,

Got your research request:

  ${summary}

I'm starting now. The full report will follow in a separate reply (typically under a minute).

— ${EMAIL_FRIENDLY_NAME}`;
}

/** Synthesise a chat-history user message from an inbound email. */
export function buildEmailUserMessage(
  question: string,
  sender: string,
  subject: string
): UIMessage<EmailMessageMeta> {
  return {
    id: `email-${rid()}`,
    role: "user",
    parts: [{ type: "text", text: question }],
    metadata: {
      source: "email",
      from: sender,
      subject: subject || "(no subject)",
      receivedAt: Date.now()
    }
  };
}

/** Synthesise a chat-history assistant message from a generated report. */
export function buildEmailAssistantMessage(report: string): UIMessage {
  return {
    id: `email-reply-${rid()}`,
    role: "assistant",
    parts: [{ type: "text", text: report }]
  };
}

// ── HTML rendering ───────────────────────────────────────────────────

/** UTF-8-safe base64 encode (mermaid.ink expects standard base64). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

/**
 * Replace every ` ```mermaid ` fenced block with a mermaid.ink-hosted PNG.
 * Mail clients can't run Mermaid's JS, so we delegate rendering to the
 * public service and the recipient's mail client fetches the image like
 * any other remote image when they open the email.
 */
function inlineMermaidImages(markdown: string): string {
  return markdown.replace(/```mermaid\s*\n([\s\S]*?)\n```/g, (match, code) => {
    const source = (code as string).trim();
    if (!source) return match;
    try {
      const url = `https://mermaid.ink/img/${base64Utf8(source)}?type=png`;
      const firstLine = source
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !/^(%%|---)/.test(l));
      const caption = firstLine
        ? `Diagram: ${firstLine.slice(0, 80)}`
        : "Diagram";
      return `![${caption}](${url})`;
    } catch (err) {
      console.warn("[ResearchAgent] mermaid encode failed:", err);
      return match;
    }
  });
}

/** Render a markdown report as a self-contained HTML email body. */
export function renderMarkdownEmail(markdown: string): string {
  const withDiagrams = inlineMermaidImages(markdown);
  const body = marked.parse(withDiagrams, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${EMAIL_HTML_STYLE}</style></head><body>${body}</body></html>`;
}
