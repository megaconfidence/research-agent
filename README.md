# Deep Research Agent

![npm i agents command](./npm-agents-banner.svg)

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/megaconfidence/research-agent"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>

A deep-research agent for Cloudflare Workers. Email a question or open the chat — it searches the web in a real headless Chrome, reads promising sources, captures structured data or screenshots, and replies with a cited Markdown / HTML report.

No API keys to manage: the LLM runs on **Workers AI**, search and page rendering go through the Cloudflare **Browser** binding.

## How it works

The whole thing is one Durable Object (`ResearchAgent extends AIChatAgent`) with two entry points — chat WebSocket and inbound email — both running the same pipeline:

```
incoming chat / email
  └─► ResearchAgent.{onChatMessage | onEmail}
        ├─ setState({ topic, status: "researching" })
        ├─ streamText (Workers AI: glm-4.7-flash) with 5 tools + MCP tools
        │     ├─ web_search         ─► DuckDuckGo HTML  ─► state.sources["search-result"]
        │     ├─ read_url           ─► page.goto + content extraction
        │     │                        ─► state.sources["read"]
        │     ├─ extract_data       ─► page text + Llama JSON-schema
        │     │                        ─► state.sources["extract"]
        │     ├─ capture_screenshot ─► JPEG data URI  ─► state.sources["screenshot"]
        │     └─ save_finding       ─► state.findings += { text, sourceUrls }
        └─ persistMessages([..., assistantMsg]) + setState({ status: "complete" })
```

**State sync.** The agent's typed state (`topic`, `status`, `sources[]`, `findings[]`, `lastError`) is stored in SQLite by the Agents SDK and broadcast over WebSocket on every `setState`. The React client subscribes via `useAgent({ onStateUpdate })`, so the right-hand sidebar updates within milliseconds of each tool call — no polling.

**Browser handle.** Launched lazily on the first tool call of a turn via `puppeteer.launch(env.BROWSER)`, reused across every tool call in the same turn (a search → 5 reads → 2 screenshots opens _one_ browser session), and torn down in `onFinish` / `onError`.

**Email and chat share state.** Both routes target the same `default` instance of `ResearchAgent` — chat via `useAgent({ agent: "ResearchAgent" })`, email via `createCatchAllEmailResolver("ResearchAgent", "default")`. It's literally one Durable Object handling both entry points, so email-driven turns appear in the chat UI live with a 📧 badge, and the same sources/findings sidebar updates in real time.

**Report shape.** The system prompt enforces a consistent skeleton: H1 / hero image / Executive Summary / Key Findings / Detailed Analysis / Visualizations (optional Mermaid) / Sources with `[^N]` footnotes. Every claim must cite a source, image URLs must come from a tool result. `stopWhen: stepCountIs(20)` caps each turn at 20 model steps.

## Tools

The LLM composes a research session out of these primitives. All five (plus any MCP servers added through the header panel) are merged into the agent's toolset.

| Tool                 | What it does                                                                                                                                                                                                          | Returns                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `web_search`         | Searches `html.duckduckgo.com`, scrapes `.result` nodes, unwraps DuckDuckGo's `/l/?uddg=…` redirector to recover real URLs                                                                                            | `{ query, results: [{ title, url, snippet }] }`       |
| `read_url`           | Navigates to URL, strips chrome (`script/style/nav/header/footer/aside`), extracts `innerText` from `<article>` / `<main>` / `<body>`, picks a hero from `og:image` / `twitter:image` plus 5 ranked `<figure>` images | `{ url, title, content, primaryImage, images }`       |
| `extract_data`       | Same navigation as `read_url`, then calls `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with a JSON Schema you describe to pull structured records out of the page                                                       | `{ url, title, instruction, data: { items: [...] } }` |
| `capture_screenshot` | JPEG screenshot at 1280×720 (or `fullPage: true`), base64-encoded for inline markdown embedding                                                                                                                       | `{ url, caption, dataUri, sizeBytes }`                |
| `save_finding`       | Pure state write — pins a fact to one or more source URLs, updates the live sidebar and the report's citation list                                                                                                    | `{ id, saved, totalFindings }`                        |

Adding a tool is straightforward: write an `inputSchema` (Zod) + an `execute` function in `src/server/tools.ts`, and optionally call `deps.upsertSource` / `deps.addFinding` to surface progress in the UI.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Try one of the suggested prompts or ask anything researchable.

You'll need a Cloudflare account with **Browser Run** enabled. The included `wrangler.jsonc` sets `"remote": true` for the AI, Browser, and Email Service bindings, so even local `npm run dev` runs against the real Cloudflare services — search, page rendering, and outbound mail behave the same locally and deployed.

### Email interface (optional)

Anyone can email a question and get back a cited HTML report. To enable:

1. Onboard your sending domain at **Compute & AI → Email Service → Onboard Domain** in the Cloudflare dashboard, and add the SPF + DKIM records it gives you.
2. Add an Email Routing rule that sends inbound mail to this Worker (catch-all or a specific address — both end up at the same agent instance).
3. Copy `.env.example` to `.env` and set the sender address:
   ```
   EMAIL_FROM=research@yourdomain.com
   ```
   `wrangler dev` reads `.env` automatically. To upload it as a production secret:
   ```bash
   npm run deploy:env
   ```

Test the inbound flow without sending real mail — `wrangler dev` exposes a local email handler:

```bash
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

Watch the Vite log for `[ResearchAgent] inbound from <addr>: "<subject>"` (sender resolved), `Email handler replied to sender` (the ack), and `[ResearchAgent] sent report to <addr> messageId=…` (the final HTML report). Open the chat UI to see the email-driven turn appear live with a 📧 badge.

## Deploy

```bash
npm run deploy
```

Make sure Browser Run is enabled on your account ([free tier](https://developers.cloudflare.com/browser-run/pricing/)).

## Learn more

- [Agents SDK](https://developers.cloudflare.com/agents/)
- [Browser Run](https://developers.cloudflare.com/browser-run/) · [Puppeteer integration](https://developers.cloudflare.com/browser-run/puppeteer/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/) · [Function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/)
- [Streamdown](https://streamdown.ai) — streaming-aware Markdown renderer

## License

MIT
