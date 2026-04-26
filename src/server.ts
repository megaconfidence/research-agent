import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentEmail, routeAgentRequest } from "agents";
import {
  type AgentEmail,
  createCatchAllEmailResolver,
  isAutoReplyEmail
} from "agents/email";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage
} from "ai";
import PostalMime from "postal-mime";
import { marked } from "marked";
import { z } from "zod";

// ── Research state ────────────────────────────────────────────────────

type SourceKind = "search-result" | "read" | "extract" | "screenshot";

type Source = {
  id: string;
  url: string;
  title: string;
  snippet?: string;
  kind: SourceKind;
  timestamp: number;
};

type Finding = {
  id: string;
  text: string;
  sourceUrls: string[];
  timestamp: number;
};

type Status = "idle" | "researching" | "complete";

type ResearchState = {
  topic: string | null;
  status: Status;
  sources: Source[];
  findings: Finding[];
  startedAt: number | null;
  lastError: string | null;
};

const INITIAL_STATE: ResearchState = {
  topic: null,
  status: "idle",
  sources: [],
  findings: [],
  startedAt: null,
  lastError: null
};

function rid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[…truncated]`;
}

function safeUrl(input: string): string {
  try {
    return new URL(input).toString();
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
}

/**
 * Extra fields we attach to a UIMessage when it was created from an inbound
 * email. Picked up by the chat UI to render a "📧 from <address>" badge.
 */
export type EmailMessageMeta = {
  source: "email";
  from: string;
  subject: string;
  receivedAt: number;
};

const EMAIL_FRIENDLY_NAME = "Research Agent";

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

/**
 * UTF-8-safe base64 encode. mermaid.ink expects standard base64 of the
 * raw diagram source.
 */
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
 * Replace every ` ```mermaid ` fenced block in the markdown with an
 * `![diagram](https://mermaid.ink/img/<base64>?type=png)` image. Mail
 * clients can't execute Mermaid's JS, so we delegate rendering to the
 * mermaid.ink public service which returns a PNG for any base64-encoded
 * diagram source. The recipient's mail client fetches the image like
 * any other remote image when they open the email.
 */
function inlineMermaidImages(markdown: string): string {
  return markdown.replace(/```mermaid\s*\n([\s\S]*?)\n```/g, (match, code) => {
    const source = (code as string).trim();
    if (!source) return match;
    try {
      const url = `https://mermaid.ink/img/${base64Utf8(source)}?type=png`;
      // Pull a short caption from the first non-directive line so the
      // image alt text is meaningful.
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

/** Render a markdown string to a self-contained HTML document for email. */
function renderMarkdownEmail(markdown: string): string {
  // marked supports GFM (tables, footnotes, fenced code) by default.
  // Mermaid blocks would otherwise render as <pre><code class="language-mermaid">
  // — readable but unrendered. inlineMermaidImages swaps them for
  // mermaid.ink-hosted PNG <img> references before marked.parse runs.
  const withDiagrams = inlineMermaidImages(markdown);
  const body = marked.parse(withDiagrams, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${EMAIL_HTML_STYLE}</style></head><body>${body}</body></html>`;
}

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
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

const SYSTEM_PROMPT = `You are an expert research analyst. You conduct deep, multi-source research using a real headless browser, then deliver well-structured Markdown reports with citations.

# Workflow

For every research question, work through these steps. Don't narrate the workflow — just do it.

1. **Plan briefly.** In one short paragraph (or skip if obvious), outline 3–5 sub-questions you'll investigate.
2. **Search broadly.** Call \`web_search\` 2–4 times with diverse queries. Use different angles (definitions, latest news, criticism, alternatives, statistics).
3. **Read deeply.** Pick the most promising 4–8 sources from search results and call \`read_url\` on each to get full content. Don't trust snippets alone.
4. **Extract structured data** with \`extract_data\` when a page contains tabular info (specs, pricing, rankings, benchmarks).
5. **Capture screenshots** with \`capture_screenshot\` only when visual evidence matters (a chart on a page, a UI being discussed). Don't take screenshots of plain text articles. Limit to ~3 per report.
6. **Save findings** with \`save_finding\` for each non-trivial fact you discover, tagged with the source URL(s) that support it. This builds the citation list and progress sidebar.
7. **Synthesize.** Compose the final report.

# Final report format

Always end with a Markdown report in this exact shape:

\`\`\`
# {Concise Topic Title}

![{caption from primaryImage.alt or your own}]({primaryImage.src from read_url})

## Executive Summary

A 2–4 sentence plain-language overview that a busy reader can absorb in 10 seconds.

## Key Findings

- Bullet points with **bold** key terms and inline citations like \`[^1]\`.
- Each bullet is a single, self-contained insight.

## Detailed Analysis

### {Sub-question 1}

Multiple paragraphs, comparison tables, or Mermaid diagrams as appropriate.

![{descriptive caption}]({images[N].src from read_url})

### {Sub-question 2}
…

## Visualizations

(Optional. Only include if you have a chart that clarifies the story. Use Mermaid.)

\`\`\`mermaid
pie title Market share (2025)
  "Vendor A" : 42
  "Vendor B" : 31
  "Other"    : 27
\`\`\`

## Sources

[^1]: [Page title](https://url) — one-line summary of what you used this for.
[^2]: [Other page](https://url) — …
\`\`\`

# Markdown rules

- **Citations**: Every factual claim has an inline \`[^N]\` marker that maps to the Sources section. Don't invent sources. If a claim has no source, say "I could not verify this".
- **Tables**: Use GFM pipe tables for comparisons (≥3 items × ≥2 attributes).
- **Charts**: Use \`\`\`mermaid blocks for diagrams. Supported types include \`flowchart TD\`, \`sequenceDiagram\`, \`gantt\`, \`pie title …\`, \`xychart-beta\`. Keep them small and readable.
- **Images** (REQUIRED): Every report must include **at least one image** when sources have any. Use this priority:
  1. Place the \`primaryImage.src\` returned by \`read_url\` of your top source as a hero image right after the H1.
  2. Embed 1–2 \`images[].src\` from \`read_url\` inside relevant Detailed Analysis subsections (e.g. an architecture diagram, screenshot of a UI, chart from the article). Use the image's \`alt\` as the caption when present.
  3. If pages had no useful images and the topic involves a UI/dashboard/chart, call \`capture_screenshot\` and embed the returned \`dataUri\`.
  Use \`![caption](url)\` syntax. **Never invent image URLs** — only use URLs that came from a \`read_url\` or \`capture_screenshot\` tool result in this conversation. Don't include the same image twice.
- **Headings**: Exactly one H1 (the topic). Use H2 for sections, H3 for subsections.

# Quality bar

- Cross-reference contested claims across multiple sources.
- Flag uncertainty explicitly ("Source X claims… but Source Y disputes…").
- Be concise. The report should be skimmable, not exhaustive.
- If the user's question is genuinely ambiguous, ask one clarifying question before researching.

Don't apologize, don't preface, don't summarize what you're about to do. Research, then write.`;

// ── Agent ─────────────────────────────────────────────────────────────

export class ResearchAgent extends AIChatAgent<Env, ResearchState> {
  initialState: ResearchState = INITIAL_STATE;
  maxPersistedMessages = 60;

  // In-memory browser handle, lazily launched per chat turn and reused
  // across tool calls. Lost on hibernation — relaunched on next call.
  private browser: Browser | null = null;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  // ── RPC ──

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async resetResearch() {
    this.setState(INITIAL_STATE);
  }

  // ── Browser lifecycle ──

  private async getBrowser(): Promise<Browser> {
    if (this.browser) {
      try {
        if (this.browser.connected) return this.browser;
      } catch {
        /* fallthrough to relaunch */
      }
    }
    this.browser = await puppeteer.launch(this.env.BROWSER);
    return this.browser;
  }

  private async closeBrowser() {
    if (!this.browser) return;
    const b = this.browser;
    this.browser = null;
    try {
      await b.close();
    } catch {
      /* swallow */
    }
  }

  // ── State helpers ──

  private upsertSource(input: {
    url: string;
    title: string;
    snippet?: string;
    kind: SourceKind;
  }): Source {
    const existing = this.state.sources.find(
      (s) => s.url === input.url && s.kind === input.kind
    );
    if (existing) return existing;
    const source: Source = {
      id: rid(),
      timestamp: Date.now(),
      ...input
    };
    this.setState({
      ...this.state,
      sources: [...this.state.sources, source]
    });
    return source;
  }

  private addFinding(text: string, sourceUrls: string[]): Finding {
    const finding: Finding = {
      id: rid(),
      text,
      sourceUrls,
      timestamp: Date.now()
    };
    this.setState({
      ...this.state,
      findings: [...this.state.findings, finding]
    });
    return finding;
  }

  private maybeCaptureTopic() {
    const firstUser = this.messages.find((m) => m.role === "user");
    if (!firstUser) return;
    const parts = (
      firstUser as { parts?: Array<{ type: string; text?: string }> }
    ).parts;
    const text = parts?.find((p) => p.type === "text")?.text;
    if (!text) return;
    if (this.state.topic && this.state.status === "researching") return;
    this.setState({
      ...this.state,
      topic: this.state.topic ?? text.slice(0, 240),
      status: "researching",
      lastError: null,
      startedAt: this.state.startedAt ?? Date.now()
    });
  }

  // ── Chat handler ──

  /**
   * Build the streamText config shared between chat (streaming) and email
   * (collected). Both run the same model, system prompt, and tool set so a
   * report doesn't differ depending on entry point.
   */
  private buildResearchStream(args: {
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
    onFinish?: () => Promise<void> | void;
    onError?: (error: unknown) => Promise<void> | void;
  }) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    return streamText({
      // GLM-4.7-Flash from Zhipu AI — fast, cheap, 131k context, with strong
      // multi-turn tool calling and instruction-following across 100+ languages.
      // Swap to "@cf/openai/gpt-oss-120b" (heavier reasoning) or
      // "@cf/moonshotai/kimi-k2.6" (262k context, vision) for different tradeoffs.
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: args.messages,
      tools: {
        ...mcpTools,
        web_search: this.tool_webSearch(),
        read_url: this.tool_readUrl(),
        extract_data: this.tool_extractData(),
        capture_screenshot: this.tool_captureScreenshot(),
        save_finding: this.tool_saveFinding()
      },
      stopWhen: stepCountIs(20),
      abortSignal: args.abortSignal,
      onFinish: async () => {
        this.setState({ ...this.state, status: "complete", lastError: null });
        await this.closeBrowser();
        await args.onFinish?.();
      },
      onError: async ({ error }) => {
        console.error("[ResearchAgent] streamText error:", error);
        const message =
          error instanceof Error ? error.message : String(error ?? "unknown");
        this.setState({
          ...this.state,
          status: "complete",
          lastError: message
        });
        await this.closeBrowser();
        await args.onError?.(error);
      }
    });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    this.maybeCaptureTopic();

    const result = this.buildResearchStream({
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Email handler ──

  /**
   * Inbound email entry point. All emails route to this single shared
   * instance via `createCatchAllEmailResolver` so chat and email both
   * read/write the same `state` (sources, findings, topic) and the same
   * persisted message history. Connected chat clients see email-driven
   * research happen in real time.
   *
   * Flow:
   *   1. Parse, drop auto-replies (avoid loops).
   *   2. Reply with an immediate ack so the sender knows we got it.
   *   3. Persist the question as a user message in chat (with email metadata
   *      so the UI can show a 📧 badge).
   *   4. Run the same research streamText pipeline used by chat.
   *   5. Persist the final assistant message and email it back as HTML.
   */
  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    // Convert postal-mime's header objects to the EmailHeader[] shape
    // expected by isAutoReplyEmail.
    const headers = (parsed.headers ?? []).map((h) => ({
      key: String(h.key ?? "").toLowerCase(),
      value: String(h.value ?? "")
    }));
    if (isAutoReplyEmail(headers)) {
      console.log(`[ResearchAgent] skipping auto-reply from ${email.from}`);
      return;
    }

    const subject = (parsed.subject ?? "").trim();
    const bodyText = (parsed.text ?? "").trim();
    const question = [subject, bodyText].filter(Boolean).join("\n\n").trim();
    if (!question) {
      email.setReject("Empty research request — include a subject or body.");
      return;
    }

    // Capture sender + Message-ID before any awaits — Cloudflare's
    // EmailMessage.reply() can only be called ONCE per inbound message,
    // so the final report must go out via sendEmail() instead. We need
    // these values to thread the outbound message correctly.
    //
    // Resolve the "who do we reply to" in the order mail clients use:
    //   1. Reply-To: header (explicit override by sender)
    //   2. From: header   (canonical author, what clients display)
    //   3. envelope MAIL FROM (last resort — can be a bounce address
    //      or a forwarder when mail goes through relays)
    const replyToHeader = parsed.replyTo?.[0]?.address?.trim();
    const fromHeader = parsed.from?.address?.trim();
    const envelopeFrom = email.from?.trim();
    const senderAddress = replyToHeader || fromHeader || envelopeFrom;
    if (!senderAddress) {
      console.error(
        `[ResearchAgent] no usable sender address — envelope=${envelopeFrom ?? "?"} from=${fromHeader ?? "?"} replyTo=${replyToHeader ?? "?"}`
      );
      email.setReject("Could not determine reply address");
      return;
    }
    console.log(
      `[ResearchAgent] inbound: envelope=${envelopeFrom ?? "?"} from=${fromHeader ?? "?"} replyTo=${replyToHeader ?? "?"} → reply to ${senderAddress}`
    );

    const inReplyToId = parsed.messageId; // typically "<abc@host>"
    const replySubject = subject
      ? subject.toLowerCase().startsWith("re:")
        ? subject
        : `Re: ${subject}`
      : "Re: Your research request";

    // 1. Acknowledge immediately via the inbound reply channel. This
    //    consumes Cloudflare's once-per-message reply slot — every
    //    follow-up has to use sendEmail() instead.
    const ackBody = `Hi,\n\nGot your research request:\n\n  ${subject || question.slice(0, 120)}\n\nI'm starting now. The full report will follow in a separate reply (typically under a minute).\n\n— ${EMAIL_FRIENDLY_NAME}`;
    try {
      await this.replyToEmail(email, {
        fromName: EMAIL_FRIENDLY_NAME,
        body: ackBody,
        contentType: "text/plain"
      });
    } catch (err) {
      console.error("[ResearchAgent] ack reply failed:", err);
      // If even the ack failed (e.g. unverified sender), bail rather than
      // running expensive research nobody will receive.
      return;
    }

    // 2. Show the email-triggered turn in the chat UI by persisting a user
    //    message. AIChatAgent.persistMessages() broadcasts to connected
    //    clients via WebSocket — so the chat history scrolls to a new
    //    "user" bubble in real time, badged as email.
    const meta: EmailMessageMeta = {
      source: "email",
      from: senderAddress,
      subject: subject || "(no subject)",
      receivedAt: Date.now()
    };
    const userMessage: UIMessage<EmailMessageMeta> = {
      id: `email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      parts: [{ type: "text", text: question }],
      metadata: meta
    };
    await this.persistMessages([...this.messages, userMessage]);

    // 3. Update research state — drives the live sidebar.
    this.setState({
      ...this.state,
      topic: subject || question.slice(0, 240),
      status: "researching",
      lastError: null,
      startedAt: Date.now()
    });

    // 4. Run research. We don't reuse chat history here — each email is an
    //    independent turn so prior conversation doesn't leak between users.
    const stream = this.buildResearchStream({
      messages: [{ role: "user", content: question }]
    });

    let report: string;
    try {
      report = await stream.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ResearchAgent] email research failed:", err);
      // Failure path: ack already consumed the reply channel, so notify
      // the sender via sendEmail() (threaded with inReplyTo).
      await this.sendOutboundEmail({
        to: senderAddress,
        subject: replySubject,
        text: `Sorry — research failed:\n\n${message}\n\nPlease try again.`,
        inReplyTo: inReplyToId
      });
      return;
    }

    // 5. Persist the assistant response so the chat UI shows the rendered
    //    report alongside the user message.
    const assistantMessage: UIMessage = {
      id: `email-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "assistant",
      parts: [{ type: "text", text: report }]
    };
    await this.persistMessages([...this.messages, assistantMessage]);

    // 6. Send the rendered report. sendEmail() goes through the
    //    `send_email` binding, which has no per-inbound-message limit,
    //    and inReplyTo threads it under the original conversation.
    await this.sendOutboundEmail({
      to: senderAddress,
      subject: replySubject,
      html: renderMarkdownEmail(report),
      inReplyTo: inReplyToId
    });
  }

  /**
   * Wrapper around `this.sendEmail()` that fills in our `from` /
   * `replyTo` defaults and swallows send failures with a log line —
   * because a failure here can't be surfaced to the sender any other
   * way (the inbound reply channel is already used by the ack).
   */
  private async sendOutboundEmail(opts: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
  }) {
    console.log(
      `[ResearchAgent] sendEmail → to=${opts.to} subject="${opts.subject}" inReplyTo=${opts.inReplyTo ?? "(none)"} len=${(opts.html?.length ?? opts.text?.length ?? 0).toString()}`
    );
    try {
      const result = await this.sendEmail({
        binding: this.env.EMAIL,
        to: opts.to,
        from: { email: this.env.EMAIL_FROM, name: EMAIL_FRIENDLY_NAME },
        replyTo: this.env.EMAIL_FROM,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        inReplyTo: opts.inReplyTo
      });
      console.log(
        `[ResearchAgent] sendEmail ok messageId=${result?.messageId ?? "?"}`
      );
    } catch (err) {
      console.error("[ResearchAgent] sendEmail failed:", err);
    }
  }

  // ── Tools ──

  /** Search the web via DuckDuckGo HTML and return result links + snippets. */
  private tool_webSearch() {
    return tool({
      description:
        "Search the web for sources on a topic. Returns up to N results (default 8, max 15) with title, URL, and snippet. Call 2-4 times per research session with different queries to broaden coverage.",
      inputSchema: z.object({
        query: z.string().describe("Search query (2+ words)"),
        numResults: z
          .number()
          .optional()
          .describe("How many results to return (1-15, default 8)")
      }),
      execute: async ({ query, numResults }) => {
        const n = Math.min(15, Math.max(1, numResults ?? 8));
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        try {
          await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
          );
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 25000
          });

          const results = (await page.evaluate((max: number) => {
            const items = document.querySelectorAll("div.result");
            const out: Array<{
              title: string;
              url: string;
              snippet: string;
            }> = [];
            for (const item of Array.from(items)) {
              if (out.length >= max) break;
              const titleEl = item.querySelector(
                "a.result__a"
              ) as HTMLAnchorElement | null;
              const snippetEl = item.querySelector(".result__snippet");
              if (!titleEl) continue;
              let url = titleEl.getAttribute("href") || "";
              // DuckDuckGo wraps real URL in /l/?uddg=...
              try {
                if (url.startsWith("//")) url = `https:${url}`;
                const u = new URL(url, "https://duckduckgo.com");
                if (u.searchParams.has("uddg")) {
                  url = decodeURIComponent(
                    u.searchParams.get("uddg") as string
                  );
                }
              } catch {
                /* keep raw url */
              }
              const title = titleEl.textContent?.trim() || "";
              const snippet = snippetEl?.textContent?.trim() || "";
              if (!title || !url) continue;
              out.push({ title, url, snippet });
            }
            return out;
          }, n)) as Array<{
            title: string;
            url: string;
            snippet: string;
          }>;

          // Track each result as a candidate source in state
          for (const r of results) {
            this.upsertSource({
              url: r.url,
              title: r.title,
              snippet: r.snippet,
              kind: "search-result"
            });
          }

          return {
            query,
            count: results.length,
            results
          };
        } catch (err) {
          return {
            query,
            error: `Search failed: ${(err as Error).message}`,
            results: []
          };
        } finally {
          await page.close().catch(() => {});
        }
      }
    });
  }

  /** Open a URL and extract clean readable content + image URLs. */
  private tool_readUrl() {
    return tool({
      description:
        "Open a URL in a real browser, render it, and return clean readable content (title, text, key image URLs). Use this for the most promising search results to read full content.",
      inputSchema: z.object({
        url: z.string().describe("Absolute URL to read"),
        maxChars: z
          .number()
          .optional()
          .describe("Max characters of content to return (default 15000)")
      }),
      execute: async ({ url, maxChars }) => {
        const cap = Math.min(40000, Math.max(500, maxChars ?? 15000));
        const safe = safeUrl(url);
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: 1280, height: 900 });
          await page.goto(safe, {
            waitUntil: "domcontentloaded",
            timeout: 25000
          });

          const data = (await page.evaluate(() => {
            // ── Hero image from social/OG meta tags (before stripping) ──
            const metaImage = (() => {
              const sel = (q: string) =>
                document.querySelector(q)?.getAttribute("content")?.trim();
              const linkSel = (q: string) =>
                document.querySelector(q)?.getAttribute("href")?.trim();
              return (
                sel('meta[property="og:image:secure_url"]') ||
                sel('meta[property="og:image"]') ||
                sel('meta[name="twitter:image"]') ||
                sel('meta[name="twitter:image:src"]') ||
                linkSel('link[rel="image_src"]') ||
                null
              );
            })();
            const metaImageAlt =
              document
                .querySelector('meta[property="og:image:alt"]')
                ?.getAttribute("content") ||
              document
                .querySelector('meta[name="twitter:image:alt"]')
                ?.getAttribute("content") ||
              "";

            // Strip chrome/noise so it doesn't pollute images or text
            const noisy = document.querySelectorAll(
              "script, style, noscript, nav, footer, header, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [aria-hidden='true']"
            );
            for (const el of Array.from(noisy)) el.remove();

            const root =
              document.querySelector("article") ||
              document.querySelector("main") ||
              document.querySelector("[role='main']") ||
              document.body;
            const text = (root as HTMLElement).innerText || "";

            // ── Pick meaningful images from the article body ──
            const norm = (u: string) => {
              try {
                return new URL(u, location.href).toString();
              } catch {
                return null;
              }
            };
            const looksLikeChrome = (src: string, alt: string) => {
              const s = (src + " " + alt).toLowerCase();
              return (
                /\b(logo|icon|favicon|avatar|profile-photo|sprite|tracking|pixel|spacer|emoji|gravatar)\b/.test(
                  s
                ) || s.endsWith(".svg")
              );
            };

            type Cand = { src: string; alt: string; score: number };
            const seen = new Set<string>();
            const cands: Cand[] = [];

            // Prefer images inside <figure>: they tend to be content
            const figures = Array.from(
              (root as HTMLElement).querySelectorAll(
                "figure img"
              ) as NodeListOf<HTMLImageElement>
            );
            const articleImgs = Array.from(
              (root as HTMLElement).querySelectorAll(
                "img"
              ) as NodeListOf<HTMLImageElement>
            );
            const ordered: HTMLImageElement[] = [
              ...figures,
              ...articleImgs.filter((i) => !figures.includes(i))
            ];

            for (const img of ordered) {
              const src =
                img.currentSrc || img.src || img.getAttribute("data-src") || "";
              const abs = src ? norm(src) : null;
              if (!abs || seen.has(abs)) continue;
              const w = img.naturalWidth || img.width || 0;
              const h = img.naturalHeight || img.height || 0;
              if (w && w < 240) continue;
              if (h && h < 160) continue;

              // Caption: prefer <figcaption>, else alt
              let caption = img.alt || "";
              const fig = img.closest("figure");
              const figcap = fig?.querySelector("figcaption");
              if (figcap?.textContent?.trim())
                caption = figcap.textContent.trim();

              if (looksLikeChrome(abs, caption)) continue;

              // Score: figcaption > alt text > size
              let score = 0;
              if (fig) score += 3;
              if (caption.length > 0) score += 2;
              if (caption.length > 30) score += 1;
              if (w * h > 300_000) score += 2;
              else if (w * h > 80_000) score += 1;

              seen.add(abs);
              cands.push({
                src: abs,
                alt: caption.slice(0, 200),
                score
              });
            }

            cands.sort((a, b) => b.score - a.score);

            // Promote OG image to first position if not already present
            let primary: { src: string; alt: string } | null = null;
            const metaAbs = metaImage ? norm(metaImage) : null;
            if (metaAbs) {
              primary = { src: metaAbs, alt: metaImageAlt };
              const dup = cands.findIndex((c) => c.src === metaAbs);
              if (dup >= 0) cands.splice(dup, 1);
            } else if (cands[0]) {
              primary = { src: cands[0].src, alt: cands[0].alt };
              cands.shift();
            }

            const images = cands
              .slice(0, 5)
              .map(({ src, alt }) => ({ src, alt }));

            return {
              title: document.title,
              text,
              primaryImage: primary,
              images
            };
          })) as {
            title: string;
            text: string;
            primaryImage: { src: string; alt: string } | null;
            images: Array<{ src: string; alt: string }>;
          };

          this.upsertSource({
            url: safe,
            title: data.title,
            kind: "read"
          });

          return {
            url: safe,
            title: data.title,
            content: trimText(data.text.replace(/\n{3,}/g, "\n\n").trim(), cap),
            primaryImage: data.primaryImage,
            images: data.images
          };
        } catch (err) {
          return {
            url: safe,
            error: `Read failed: ${(err as Error).message}`
          };
        } finally {
          await page.close().catch(() => {});
        }
      }
    });
  }

  /** Extract structured data from a page using Workers AI. */
  private tool_extractData() {
    return tool({
      description:
        "Extract structured data (lists, tables, statistics, specs) from a webpage using AI. Use when a page contains structured info you want to compare or aggregate. Provide field names + types.",
      inputSchema: z.object({
        url: z.string().describe("Absolute URL"),
        instruction: z
          .string()
          .describe(
            "What to extract, e.g. 'Extract each product name, price (USD), and rating (1-5)'"
          ),
        fields: z
          .array(
            z.object({
              name: z.string().describe("Field name"),
              type: z
                .enum([
                  "string",
                  "number",
                  "boolean",
                  "string_array",
                  "number_array"
                ])
                .describe("Field type"),
              description: z.string().optional()
            })
          )
          .describe("List of fields to extract per item (1-20)")
      }),
      execute: async ({ url, instruction, fields }) => {
        const safe = safeUrl(url);
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        try {
          await page.goto(safe, {
            waitUntil: "domcontentloaded",
            timeout: 25000
          });
          const { text, title } = (await page.evaluate(() => {
            const noisy = document.querySelectorAll(
              "script, style, noscript, nav, footer, header"
            );
            for (const el of Array.from(noisy)) el.remove();
            return {
              title: document.title,
              text: (document.body as HTMLElement).innerText || ""
            };
          })) as { title: string; text: string };

          // Build a JSON Schema for the LLM to respect
          const itemProps: Record<string, unknown> = {};
          for (const f of fields) {
            const desc = f.description || f.name;
            switch (f.type) {
              case "number":
                itemProps[f.name] = { type: "number", description: desc };
                break;
              case "boolean":
                itemProps[f.name] = { type: "boolean", description: desc };
                break;
              case "string_array":
                itemProps[f.name] = {
                  type: "array",
                  items: { type: "string" },
                  description: desc
                };
                break;
              case "number_array":
                itemProps[f.name] = {
                  type: "array",
                  items: { type: "number" },
                  description: desc
                };
                break;
              default:
                itemProps[f.name] = { type: "string", description: desc };
            }
          }

          const schema = {
            type: "object",
            properties: {
              items: {
                type: "array",
                description: "Extracted records",
                items: {
                  type: "object",
                  properties: itemProps,
                  required: fields.map((f) => f.name)
                }
              }
            },
            required: ["items"]
          };

          const truncated = trimText(text, 28000);
          const aiResponse = await this.env.AI.run(
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            {
              messages: [
                {
                  role: "system",
                  content:
                    "You are an information extractor. Given a webpage's text and a request, return ONLY a JSON object matching the requested schema. Use null for missing fields. Do not invent values."
                },
                {
                  role: "user",
                  content: `Page title: ${title}\nURL: ${safe}\n\nInstruction:\n${instruction}\n\nPage text:\n${truncated}`
                }
              ],
              response_format: {
                type: "json_schema",
                json_schema: schema
              }
            }
          );

          let extracted: unknown;
          const responseText =
            (aiResponse as { response?: string }).response ?? aiResponse;
          if (typeof responseText === "string") {
            try {
              extracted = JSON.parse(responseText);
            } catch {
              extracted = { raw: responseText };
            }
          } else {
            extracted = responseText;
          }

          this.upsertSource({
            url: safe,
            title,
            kind: "extract"
          });

          return {
            url: safe,
            title,
            instruction,
            data: extracted
          };
        } catch (err) {
          return {
            url: safe,
            error: `Extract failed: ${(err as Error).message}`
          };
        } finally {
          await page.close().catch(() => {});
        }
      }
    });
  }

  /** Capture a JPEG screenshot and return as a data URI. */
  private tool_captureScreenshot() {
    return tool({
      description:
        "Capture a screenshot of a webpage. Returns a JPEG data URI suitable for embedding in markdown via ![caption](data-uri). Use sparingly — only when visual evidence (a chart, a UI screenshot) actually adds value. Skip for plain text pages.",
      inputSchema: z.object({
        url: z.string().describe("Absolute URL"),
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture entire scrollable page (default false)"),
        caption: z
          .string()
          .optional()
          .describe("Short caption to use when embedding the image")
      }),
      execute: async ({ url, fullPage, caption }) => {
        const safe = safeUrl(url);
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: 1280, height: 720 });
          await page.goto(safe, {
            waitUntil: "domcontentloaded",
            timeout: 25000
          });
          // Briefly settle (lazy-loaded images, web fonts)
          await new Promise((r) => setTimeout(r, 1200));

          const buffer = (await page.screenshot({
            type: "jpeg",
            quality: 70,
            fullPage
          })) as Uint8Array;

          // Convert to base64 (chunked to avoid call-stack limits on large buffers)
          let binary = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < buffer.length; i += CHUNK) {
            binary += String.fromCharCode(
              ...buffer.subarray(i, Math.min(i + CHUNK, buffer.length))
            );
          }
          const dataUri = `data:image/jpeg;base64,${btoa(binary)}`;

          const title = await page.title().catch(() => safe);
          this.upsertSource({
            url: safe,
            title,
            snippet: caption,
            kind: "screenshot"
          });

          return {
            url: safe,
            title,
            caption: caption || `Screenshot of ${safe}`,
            dataUri,
            sizeBytes: buffer.length
          };
        } catch (err) {
          return {
            url: safe,
            error: `Screenshot failed: ${(err as Error).message}`
          };
        } finally {
          await page.close().catch(() => {});
        }
      }
    });
  }

  /** Persist a research finding for the live progress sidebar + report. */
  private tool_saveFinding() {
    return tool({
      description:
        "Persist a single research finding tied to one or more source URLs. Call this for each non-trivial fact you discover. The findings panel shows progress to the user in real time and informs your final citation list.",
      inputSchema: z.object({
        text: z
          .string()
          .describe("The finding, as a self-contained sentence or two"),
        sourceUrls: z
          .array(z.string())
          .describe("URLs that support this finding (1-5)")
      }),
      execute: async ({ text, sourceUrls }) => {
        const finding = this.addFinding(text, sourceUrls);
        return {
          id: finding.id,
          saved: true,
          totalFindings: this.state.findings.length
        };
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  /**
   * Inbound mail entry. Every email — regardless of recipient address —
   * routes to the single `default` instance of `ResearchAgent` (the same
   * instance the chat UI connects to via `useAgent`). That's what makes
   * email and chat share state: there's literally one Durable Object.
   *
   * To deploy:
   *   1. Onboard your domain at Compute & AI → Email Service
   *   2. Add an Email Routing rule: any address → "Send to a Worker" → this Worker
   *   3. Set `EMAIL_FROM` in `.env` and run `npm run deploy:env`
   */
  async email(message, env, _ctx) {
    await routeAgentEmail(message, env, {
      resolver: createCatchAllEmailResolver("ResearchAgent", "default"),
      onNoRoute: (msg) => {
        console.warn(`[email] no route for ${msg.from} → ${msg.to}`);
        msg.setReject("No research agent configured for this address");
      }
    });
  }
} satisfies ExportedHandler<Env>;
