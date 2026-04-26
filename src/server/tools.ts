// Research tools used by `ResearchAgent`. Each tool is a thin wrapper
// around a Puppeteer-driven browser session plus state hooks back into
// the agent (so the live progress sidebar updates as work happens).
//
// The tools don't depend on the agent class directly: the agent passes
// in a small `ToolDeps` object with the bits each tool needs. That keeps
// the agent file focused on lifecycle/routing and lets these tools be
// unit-tested in isolation.

import type { Browser } from "@cloudflare/puppeteer";
import { tool } from "ai";
import { z } from "zod";

import type { Finding, Source, SourceKind } from "./types";
import { safeUrl, trimText } from "./utils";

/** Everything a tool needs from the host agent. */
export type ToolDeps = {
  /** Lazily-launched, reused-across-calls Puppeteer browser. */
  getBrowser: () => Promise<Browser>;
  /** Add (or no-op if duplicate) a source to research state. */
  upsertSource: (input: {
    url: string;
    title: string;
    snippet?: string;
    kind: SourceKind;
  }) => Source;
  /** Persist a finding, returning the stored record. */
  addFinding: (text: string, sourceUrls: string[]) => Finding;
  /** Current findings count — exposed so save_finding can echo it back. */
  getFindingsCount: () => number;
  /** Worker bindings — used by extract_data to call Workers AI. */
  env: Env;
};

/** Build the tool record passed into `streamText({ tools })`. */
export function createResearchTools(deps: ToolDeps) {
  return {
    web_search: webSearchTool(deps),
    read_url: readUrlTool(deps),
    extract_data: extractDataTool(deps),
    capture_screenshot: captureScreenshotTool(deps),
    save_finding: saveFindingTool(deps)
  };
}

// ── web_search ────────────────────────────────────────────────────────

/** Search the web via DuckDuckGo HTML and return result links + snippets. */
function webSearchTool(deps: ToolDeps) {
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
      const browser = await deps.getBrowser();
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
                url = decodeURIComponent(u.searchParams.get("uddg") as string);
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

        // Track each result as a candidate source in state.
        for (const r of results) {
          deps.upsertSource({
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

// ── read_url ──────────────────────────────────────────────────────────

/** Open a URL and extract clean readable content + image URLs. */
function readUrlTool(deps: ToolDeps) {
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
      const browser = await deps.getBrowser();
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

        deps.upsertSource({
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

// ── extract_data ──────────────────────────────────────────────────────

/** Extract structured data from a page using Workers AI. */
function extractDataTool(deps: ToolDeps) {
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
      const browser = await deps.getBrowser();
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
        const aiResponse = await deps.env.AI.run(
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

        deps.upsertSource({
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

// ── capture_screenshot ────────────────────────────────────────────────

/** Capture a JPEG screenshot and return as a data URI. */
function captureScreenshotTool(deps: ToolDeps) {
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
      const browser = await deps.getBrowser();
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
        deps.upsertSource({
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

// ── save_finding ──────────────────────────────────────────────────────

/** Persist a research finding for the live progress sidebar + report. */
function saveFindingTool(deps: ToolDeps) {
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
      const finding = deps.addFinding(text, sourceUrls);
      return {
        id: finding.id,
        saved: true,
        totalFindings: deps.getFindingsCount()
      };
    }
  });
}
