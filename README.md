# Deep Research Agent

![npm i agents command](./npm-agents-banner.svg)

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents-starter"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>

A deep-research agent built on Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/) and [Browser Run](https://developers.cloudflare.com/browser-run/). Ask a research question and the agent searches the web, opens promising sources in a real headless Chrome, extracts structured data, captures screenshots when useful, and produces a cited Markdown report — with sources and findings tracked live in a side panel.

No API keys to manage: search and content come from a real browser via the Cloudflare Browser binding, the model runs on Workers AI.

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Try one of the suggested prompts (Compare AI code editors / Fusion energy startups / Cloudflare Browser Run brief / Long COVID treatments) or ask anything researchable.

You'll need a Cloudflare account with Browser Run enabled. The included `wrangler.jsonc` sets `"remote": true` for both the AI and Browser bindings so the same code works locally and deployed.

## What's included

- **Real browser-driven research** — DuckDuckGo HTML search, full-page navigation, and content extraction via the Browser binding + `@cloudflare/puppeteer`
- **Five research tools** the LLM can compose:
  - `web_search` — search the web, return title/URL/snippet
  - `read_url` — open a URL, return clean readable text plus a ranked hero image (`og:image` / `twitter:image`) and up to five `<figure>`-preferred content images with captions
  - `extract_data` — pull structured records (lists, tables, specs) using a JSON schema you describe
  - `capture_screenshot` — JPEG of the viewport or full page, returned as a data URI ready to embed in markdown
  - `save_finding` — pin a fact to one or more source URLs (powers the live findings panel and the citation list in the report)
- **Live progress sidebar** — the agent's `ResearchState` (topic, status, sources, findings) syncs to every connected client over WebSockets via `setState` and `onStateUpdate`. Sources are bucketed by kind (search / read / extract / screenshot) with timestamps and host badges.
- **Rich Markdown rendering** — Streamdown with the `@streamdown/code` and `@streamdown/mermaid` plugins, so the model can emit syntax-highlighted code, GFM tables, and Mermaid charts (flowchart, pie, gantt, sequence, xychart) inline in its report.
- **Cited reports** — system prompt drives a structured output: H1 topic / Executive Summary / Key Findings / Detailed Analysis / Visualizations / Sources, with `[^N]` footnote references mapped to the Sources section.
- **MCP support** — bring your own data sources by adding any MCP server from the header panel (Wikipedia, arXiv, internal docs, etc.); their tools are merged into the agent's toolset automatically.
- **Image attachments** — drag, drop, or paste images for vision-capable models (e.g. ask the agent to research a chart in a screenshot you provide).
- **Email interface** — every email arriving at the configured address is acknowledged immediately, then triggers a full research turn. The final report is rendered as HTML and replied back, threaded against the original message. All inbound mail routes to the same Durable Object as the chat UI, so email-driven research appears live in the chat history (with a 📧 badge) and updates the same sources/findings sidebar.
- **Reasoning + debug panels** — collapsible reasoning blocks for inspecting the model's thinking, plus a debug toggle to see raw `UIMessage` JSON for each turn.
- **Error surfacing** — `streamText` errors are stored on `state.lastError` and rendered as an inline banner so transient inference failures don't silently swallow your run.

## Project structure

```
src/
  server.ts          # ResearchAgent: tools, state, system prompt, onChatMessage, onEmail
  app.tsx            # Chat UI + research sidebar + 📧 email-source badge
  client.tsx         # React entry point
  styles.css         # Tailwind + Kumo styles
wrangler.jsonc       # ai, browser, send_email, durable_objects bindings
.env                 # local + prod secrets: EMAIL_FROM (gitignored)
.env.example         # template — copy to .env
```

### Bindings

```jsonc
"ai":          { "binding": "AI",      "remote": true },
"browser":     { "binding": "BROWSER", "remote": true },
"send_email":  [{ "name": "EMAIL",     "remote": true }],
"durable_objects": {
  "bindings": [{ "class_name": "ResearchAgent", "name": "ResearchAgent" }]
}
```

`remote: true` on `browser` and `send_email` means even `npx wrangler dev` runs against the real Cloudflare browser and Email Service, so search, page rendering, and outbound mail behave the same locally and in production. The sender address comes from `EMAIL_FROM` in `.env` — read automatically by `wrangler dev` for local runs, and uploaded as a production secret with `npm run deploy:env`.

## How it works

The whole thing is one Durable Object (`ResearchAgent extends AIChatAgent`) that owns a chat session, a small piece of synchronised state, and an in-memory headless Chrome handle. Each user turn runs through the same pipeline:

```
user prompt
  └─► ResearchAgent.onChatMessage
        ├─ maybeCaptureTopic        →  setState({ topic, status: "researching" })
        ├─ streamText (Workers AI: glm-4.7-flash) with 5 tools + MCP tools
        │     ├─ web_search         ─► DuckDuckGo HTML  ─► upsertSource(kind: "search-result")
        │     ├─ read_url           ─► page.goto + innerText + image picker
        │     │                        ─► upsertSource(kind: "read")
        │     ├─ extract_data       ─► page text + Llama JSON-schema
        │     │                        ─► upsertSource(kind: "extract")
        │     ├─ capture_screenshot ─► JPEG data URI  ─► upsertSource(kind: "screenshot")
        │     └─ save_finding       ─► addFinding(text, sourceUrls)
        ├─ onFinish  →  setState({ status: "complete" })  +  closeBrowser()
        └─ onError   →  setState({ status: "complete", lastError })  +  closeBrowser()
```

### State that the client subscribes to

The agent's typed state is a single object stored in SQLite by the Agents SDK and broadcast over WebSocket whenever it changes:

```ts
type ResearchState = {
  topic: string | null; // captured from the first user message
  status: "idle" | "researching" | "complete";
  sources: Source[]; // every URL the agent touched, with kind + timestamp
  findings: Finding[]; // each is { text, sourceUrls[] }
  startedAt: number | null;
  lastError: string | null; // surfaced as a banner if streamText throws
};
```

The React client connects with `useAgent<ResearchAgent, ResearchState>({ onStateUpdate })` so the right-hand sidebar stays in lockstep with whatever the agent is doing on the server — no polling, no refetching. Every tool call ends with a `setState` so source/finding counts increment in the UI within milliseconds of each browser navigation.

### The five tools, end to end

The LLM composes a research session out of these primitives:

| Tool                 | What it actually does                                                                                                                                                                                                                                                                                                             | What it returns                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `web_search`         | Opens `html.duckduckgo.com/html/?q=…` in the headless browser, scrapes `.result` nodes, unwraps DuckDuckGo's `/l/?uddg=…` redirector to recover the real target URL                                                                                                                                                               | `{ query, count, results: [{ title, url, snippet }] }`                        |
| `read_url`           | Navigates to the URL, strips chrome (`script/style/nav/header/footer/aside/[role='banner'\|'navigation'\|'contentinfo']`), pulls clean `innerText` from `<article>` / `<main>` / `<body>`, extracts a hero image from `og:image` / `twitter:image` meta tags, plus 5 ranked content images preferring `<figure>` + `<figcaption>` | `{ url, title, content, primaryImage: { src, alt }, images: [{ src, alt }] }` |
| `extract_data`       | Same navigation as `read_url`, then calls `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with a JSON Schema you describe (field names + types) to pull structured records out of the page text                                                                                                                                        | `{ url, title, instruction, data: { items: [...] } }`                         |
| `capture_screenshot` | JPEG screenshot at 1280×720 (or `fullPage: true`), quality 70, base64-encoded chunked to stay under V8's call-stack limit                                                                                                                                                                                                         | `{ url, title, caption, dataUri: "data:image/jpeg;base64,…", sizeBytes }`     |
| `save_finding`       | Pure state write — no I/O. Pins a fact to one or more source URLs and updates the live sidebar                                                                                                                                                                                                                                    | `{ id, saved, totalFindings }`                                                |

The browser is launched lazily via `puppeteer.launch(env.BROWSER)` on the first tool call of a turn, reused across every subsequent call in the same turn (so a search → 5 reads → 2 screenshots opens _one_ browser session), and torn down in `onFinish` / `onError`.

### How the report gets its shape

The system prompt does most of the work. It defines:

1. **A workflow** — plan → search broadly (2–4 queries) → read 4–8 sources deeply → optionally extract structured data and capture screenshots → save findings → synthesize.
2. **An exact report skeleton** — H1, hero `![](primaryImage.src)` right under the H1, Executive Summary, Key Findings (bulleted with bold leads), Detailed Analysis (H3 subsections with paragraphs / tables / mermaid), optional Visualizations, then Sources as `[^N]` footnote definitions.
3. **Hard rules** — every claim cites a `[^N]`, image URLs must come from a tool result (no fabrication), tables are used for ≥3-row comparisons, Mermaid for diagrams, exactly one H1.

`stopWhen: stepCountIs(20)` caps the agent at 20 model steps per turn so it can't loop forever.

### How images and charts end up in the report

- **Hero image:** the `read_url` tool extracts the page's social/OG image from `<meta>` tags before the chrome-stripping pass — that's the canonical hero (typically 1200×628). The system prompt requires it directly under the H1.
- **In-section images:** `read_url` also returns up to 5 ranked content images, preferring those inside `<figure>` elements with a `<figcaption>` (which becomes the markdown caption).
- **Custom screenshots:** when no source has a useful image, the model can call `capture_screenshot` and embed the returned `data:image/jpeg;base64,…` URI inline.
- **Mermaid charts:** the `@streamdown/mermaid` plugin renders ` ```mermaid ` code fences as live SVG. The model is told it can use `flowchart TD`, `sequenceDiagram`, `gantt`, `pie title …`, `xychart-beta`.
- **Code & tables:** the `@streamdown/code` plugin handles syntax highlighting; GFM pipe tables are native to Streamdown.

### Layout & scroll

The whole shell is `flex flex-col h-screen overflow-hidden` with `html, body, #root { overflow: hidden }`. The chat column and the right sidebar are independently scrollable; the document itself never scrolls. Auto-scroll-to-bottom on new messages targets the chat container directly via `messageScrollRef.current.scrollTo(...)` so it can't bubble up and shift the page.

### Image attachments and MCP

- **Drop / paste / pick** an image into the input and it's sent as a file part on the next message — useful for "research what's in this chart" prompts on vision-capable models.
- **MCP servers** added through the header panel are connected via `this.mcp.connect(url)`. Their tools are merged with the built-in five via `...this.mcp.getAITools()` so the agent can transparently use, say, a Wikipedia or arXiv MCP alongside the browser tools. The OAuth popup callback is wired up in `onStart()`.

## Email interface

Anyone can email a research question and get back a cited HTML report. The sketch:

```
incoming email (any address on your domain)
  └─► Worker `email()` handler
        └─ routeAgentEmail(message, env, {
             resolver: createCatchAllEmailResolver("ResearchAgent", "default")
           })
        └─► ResearchAgent (default instance — same one chat connects to)
              └─ onEmail(email)
                    ├─ PostalMime.parse + isAutoReplyEmail → drop loops
                    ├─ this.replyToEmail(...)              ← ack (text/plain)
                    │                                         consumes the inbound
                    │                                         reply channel (one-shot)
                    ├─ persistMessages([..., userMsg])     ← shows up in chat UI
                    │  with metadata { source: "email", from }    (📧 badge)
                    ├─ buildResearchStream → streamText (same tools as chat)
                    ├─ persistMessages([..., assistantMsg])← rendered in chat UI
                    └─ this.sendEmail({ inReplyTo, ... })  ← final HTML report
                                                              via `send_email`
                                                              binding, threaded
                                                              with the Message-ID
```

**Why this shares state with the chat UI**: the `email()` handler routes every inbound message to a single instance named `default`. The chat client's `useAgent({ agent: "ResearchAgent" })` defaults to that same `default` instance — so it's literally one Durable Object handling both entry points. `state.sources`, `state.findings`, the chat message history, are one timeline.

**Setup (one time):**

1. Onboard your sending domain at **Compute & AI → Email Service → Onboard Domain** in the Cloudflare dashboard, and add the SPF + DKIM records it gives you.
2. Create an Email Routing rule that routes inbound mail to this Worker (catch-all or a specific address — both end up at the same agent instance because of the resolver).
3. Set the sender address in `.env` (gitignored — copy `.env.example` to start):
   ```
   EMAIL_FROM=research@yourdomain.com
   ```
   `wrangler dev` reads it automatically for local runs. To upload it (and any other secrets you add to `.env`) to your deployed Worker:
   ```bash
   npm run deploy:env
   ```
   This wraps `wrangler secret bulk .env`, which accepts the same `KEY=VALUE` format.

**Try it locally:**

`wrangler dev` exposes a `/cdn-cgi/handler/email` endpoint that simulates an inbound email and triggers your Worker's `email()` handler. With the dev server running:

```bash
# Replace the from/to addresses with your own — the agent will reply
# to whatever address sends the test message.
SENDER='you@yourdomain.com'
RECIPIENT='research@yourdomain.com'

curl -X POST 'http://localhost:5173/cdn-cgi/handler/email' \
  --url-query "from=$SENDER" \
  --url-query "to=$RECIPIENT" \
  --header 'Content-Type: application/json' \
  --data-raw "From: \"You\" <$SENDER>
To: $RECIPIENT
Reply-To: $SENDER
Subject: Compare Bun vs. Deno vs. Node for Workers
Message-ID: <test-1@example.com>
Date: Mon, 01 Jan 2026 12:00:00 +0000

What are the tradeoffs?"
```

Watch the Vite terminal log for `[ResearchAgent] inbound: envelope=… from=… replyTo=… → reply to <addr>` to confirm the sender was picked up correctly, then `Email handler replied to sender` (ack) and `[ResearchAgent] sendEmail ok messageId=…` (final report). The `.eml` files Miniflare wrote contain the messages. Open the chat UI at `http://localhost:5173` and you'll see the email-driven turn appear with a 📧 badge showing the actual sender's address.

**Notes / known limits:**

- The whole research run is synchronous inside `onEmail()`. A typical brief takes 25–60s; the inbound-email request stays open for that time. If you want to ack and run later, store sender details in state and use `this.schedule(0, ...)` to defer.
- Auto-replies (RFC 3834 `Auto-Submitted`, `X-Auto-Response-Suppress`, `Precedence: bulk`) are detected by `isAutoReplyEmail()` and dropped to avoid mail loops.
- **One ack, one report — different mechanisms.** Cloudflare's Email Service caps `EmailMessage.reply()` at one call per inbound message, so we use `replyToEmail()` for the ack only and switch to `sendEmail()` (via the `send_email` binding) for the final report. The `inReplyTo` field on `sendEmail()` carries the original `Message-ID` so mail clients still thread both messages under the same conversation. Calling `replyToEmail()` twice produces a `mail has already been replied to` error in production.
- The HTML reply is rendered with `marked` and includes inline CSS for typography, tables, code, and blockquotes. Mermaid blocks are pre-processed: each ` ```mermaid ` fence is base64-encoded and rewritten as `![Diagram: …](https://mermaid.ink/img/<b64>?type=png)`, so mail clients fetch a rendered PNG from the public [mermaid.ink](https://mermaid.ink) service. Recipients on Gmail/Apple Mail/Outlook see the diagram inline once they allow remote images. If you'd rather not depend on an external service, swap `inlineMermaidImages()` for a puppeteer-based renderer using the `BROWSER` binding you already have.
- Locally, Miniflare logs `replyToEmail()` as `Email handler replied to sender` but doesn't print a corresponding line for `sendEmail()` calls. Watch for the `[ResearchAgent] sendEmail ok messageId=…` log line instead to confirm the final report went out.
- Without `secret` on `replyToEmail()`, follow-up replies don't auto-route back to a specific instance via signature verification. We don't need that here because there's only one instance — every reply ends up at the same `default` agent regardless. Add `EMAIL_SECRET` + `createSecureReplyEmailResolver` if you ever shard email per-user.

## Customising

### Swap the model

Workers AI ships several capable function-calling models. Swap one line in `server.ts`:

```ts
model: workersai("@cf/zai-org/glm-4.7-flash"),    // default — fast, 131k ctx, reliable tool calling
// model: workersai("@cf/moonshotai/kimi-k2.6"),  // 262k ctx, vision, reasoning — but inference is currently flaky
// model: workersai("@cf/openai/gpt-oss-120b"),   // heavier reasoning, slower
```

In testing, `glm-4.7-flash` finishes a multi-source brief in ~25–60s with reliable tool calling and is the most stable on Workers AI today. `kimi-k2.6` produces nicely formatted footnote superscripts when it works, but inference has been unreliable in practice. `gpt-oss-120b` sometimes emits tool calls as inline JSON in its reasoning channel rather than as structured calls — fine for some queries, unreliable for others.

You can also wire up a non-Workers-AI provider (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) the same way as any AI SDK app.

### Tighten or relax the workflow

The system prompt in `server.ts` defines the research workflow (plan → search → read → extract → screenshot → save → synthesize) and the report format (Executive Summary / Key Findings / Detailed Analysis / Visualizations / Sources, with `[^N]` citations). Edit it to:

- enforce a different report shape (e.g. always include a Mermaid chart, always produce a comparison table)
- restrict to specific domains (`site:` filters in `web_search` queries)
- raise/lower the step budget (`stopWhen: stepCountIs(20)`)

### Add tools

The five built-in tools are good defaults but trivial to extend. Common additions:

- `query_arxiv` — wrap arXiv's API for academic sources
- `summarize_pdf` — fetch a PDF, run it through Workers AI for summarisation
- `query_db` — read from your own D1/Postgres for proprietary research
- `slack_notify` — broadcast a finding to a channel as it's discovered

Each tool just needs an `inputSchema` (Zod), an `execute` function, and (optionally) a call to `this.upsertSource` / `this.addFinding` to surface progress in the sidebar.

### Persist screenshots and reports

Right now screenshots are returned inline as base64 data URIs and the final report lives in chat history. To keep them durably:

- Save screenshots to **R2** in `capture_screenshot` and return the public URL instead of a data URI.
- Save the final markdown report to the agent's SQL (`this.sql`...) or to **D1** for cross-session retrieval.
- Use **Vectorize** to embed findings and let the agent recall context from previous research turns.

### Connect MCP servers

Click the **MCP** button in the header to add a server URL — its tools merge into the agent's toolset automatically (`this.mcp.getAITools()` is already wired into `streamText`). The included OAuth callback handles auth-required servers.

## Deploy

```bash
npm run deploy
```

Make sure your account has **Browser Run** enabled (see [pricing](https://developers.cloudflare.com/browser-run/pricing/) — there's a generous free tier).

## Tradeoffs and known limits

- **DuckDuckGo HTML** is used as the search backend because it doesn't require an API key. It's occasionally rate-limited or returns degraded results; swap to Brave/Bing/Tavily as a search-API replacement if you need higher reliability.
- **Tool input schemas** intentionally avoid `default()` / `min()` / `max()` Zod constraints — when serialised to JSON Schema some Workers AI models choke on them. Constraints are enforced manually inside `execute()`.
- **Browser sessions** are reused across tool calls within a turn and torn down in `onFinish` / `onError`. Long-running sessions across turns aren't kept (they don't survive Durable Object hibernation), but a Durable-Object-managed pool is straightforward to add ([example](https://developers.cloudflare.com/browser-run/how-to/browser-run-with-do/)).
- **Inline screenshot data URIs** can bloat message history. For longer-running agents, swap to R2-backed URLs.

## Learn more

- [Agents SDK](https://developers.cloudflare.com/agents/)
- [Browser Run](https://developers.cloudflare.com/browser-run/) · [Quick Actions REST API](https://developers.cloudflare.com/browser-run/quick-actions/) · [Puppeteer integration](https://developers.cloudflare.com/browser-run/puppeteer/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/) · [Function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/) · [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [MCP Client API](https://developers.cloudflare.com/agents/api-reference/mcp-client-api/)
- [Streamdown](https://streamdown.ai) — streaming-aware Markdown renderer

## License

MIT
