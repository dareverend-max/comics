// Longbox Arc Finder — Cloudflare Worker.
// Serves the web page and proxies a small set of read-only Metron API calls,
// keeping the Metron token server-side (set it as the METRON_TOKEN secret).
//
// worker.js is generated from this file + index.html by `node build.mjs`.

const HTML = __HTML__;

const CACHE_SECONDS = 60 * 60 * 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/summary") return summary(request, env, ctx);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    if (!env.METRON_TOKEN) {
      return json({ error: "The Worker has no METRON_TOKEN secret. Add it under Settings → Variables and Secrets." }, 500);
    }

    // Serve from Cloudflare's edge cache when we can.
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    let body;
    try {
      body = await route(url, env);
    } catch (e) {
      const status = e.status || 502;
      return json({ error: e.message || "Metron request failed" }, status);
    }
    if (body === null) return json({ error: "Not found" }, 404);

    const res = json(body, 200, { "cache-control": `public, max-age=${CACHE_SECONDS}` });
    if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

async function route(url, env) {
  const p = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const q = url.searchParams;

  // /api/series?name=&publisher=&year=
  if (p[1] === "series" && p.length === 2) {
    const params = { name: q.get("name") || "" };
    if (!params.name.trim()) throw httpError(400, "Enter a comic title.");
    if (q.get("publisher")) params.publisher_name = q.get("publisher");
    if (/^\d{4}$/.test(q.get("year") || "")) params.year_began = q.get("year");
    const rows = await metronAll(env, "series/", params, 2);
    return rows.map((s) => ({
      id: s.id,
      name: s.series,
      year: s.year_began,
      volume: s.volume,
      issues: s.issue_count,
      publisher: s.publisher?.name || "",
    }));
  }

  // /api/series/:id/issues
  if (p[1] === "series" && isId(p[2]) && p[3] === "issues") {
    const rows = await metronAll(env, "issue/", { series_id: p[2] }, 20);
    return rows.map(slimIssue);
  }

  // /api/issue/:id
  if (p[1] === "issue" && isId(p[2])) {
    const i = await metron(env, `issue/${p[2]}/`);
    const has = (c, names) => (c.role || []).some((r) => names.includes(String(r.name).toLowerCase()));
    return {
      id: i.id,
      number: i.number,
      series: i.series?.name || "",
      seriesId: i.series?.id,
      titles: (i.name || []).filter(Boolean),
      desc: (i.desc || "").trim(),
      solicit: !!i.desc_is_solicitation,
      arcs: (i.arcs || []).map((a) => ({ id: a.id, name: a.name })),
      coverDate: i.cover_date || null,
      storeDate: i.store_date || null,
      image: i.image || null,
      url: i.resource_url || `https://metron.cloud/issue/${i.id}/`,
      writers: (i.credits || []).filter((c) => has(c, ["writer"])).map((c) => c.creator).slice(0, 3),
      artists: (i.credits || []).filter((c) => has(c, ["artist", "penciller"])).map((c) => c.creator).slice(0, 3),
    };
  }

  // /api/arc/:id
  if (p[1] === "arc" && isId(p[2])) {
    const [a, issues] = await Promise.all([
      metron(env, `arc/${p[2]}/`),
      metronAll(env, `arc/${p[2]}/issue_list/`, {}, 10),
    ]);
    const list = issues.map(slimIssue).sort(
      (x, y) => String(x.coverDate).localeCompare(String(y.coverDate)) || x.id - y.id,
    );
    return { id: a.id, name: a.name, desc: (a.desc || "").trim(), issues: list };
  }

  return null;
}

// POST /api/summary — one overview of a run of issues, written by Workers AI
// from the Metron synopses the page already loaded. Needs the AI binding
// ([ai] binding = "AI" in wrangler.toml).
const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function summary(request, env, ctx) {
  if (!env.AI) {
    return json({ error: "Run overviews need Workers AI. Add an AI binding named AI to this Worker (Settings → Bindings)." }, 501);
  }
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const clip = (s, n) => String(s || "").slice(0, n);
  const issues = (Array.isArray(input.issues) ? input.issues : []).slice(0, 25).map((i) => ({
    number: clip(i.number, 12),
    title: clip(i.title, 200),
    arcs: (Array.isArray(i.arcs) ? i.arcs : []).slice(0, 4).map((a) => clip(a, 120)),
    synopsis: clip(i.synopsis, 1500),
  }));
  const mode = input.mode === "gaps" ? "gaps" : "overview";
  if (mode === "overview" && issues.filter((i) => i.synopsis).length < 2) return json({ error: "Not enough synopses to summarize." }, 400);
  if (mode === "gaps" && !issues.length) return json({ error: "No issues to fill in." }, 400);
  const series = clip(input.series, 120);
  const publisher = clip(input.publisher, 80);

  // Cache by content so repeat searches don't re-run the model.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hash = await sha256(JSON.stringify({ SUMMARY_MODEL, mode, series, publisher, issues }));
  const cacheKey = new Request(new URL(`/api/summary-cache/${hash}`, request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const listing = issues
    .map((i) =>
      `#${i.number}${i.title ? ` "${i.title}"` : ""}${i.arcs.length ? ` [arc: ${i.arcs.join(", ")}]` : ""}\n` +
      (i.synopsis || "(no synopsis available)"),
    )
    .join("\n\n");

  if (mode === "gaps") return gaps(env, ctx, cache, cacheKey, series, publisher, issues, listing);

  const messages = [
    {
      role: "system",
      content:
        "You summarize comic book runs for readers. Use ONLY the synopses provided; never add events, characters or outcomes that are not in them. " +
        "Write 2 to 4 short paragraphs of plain prose (no headings, no bullet points, no markdown). " +
        "Tell the story of the run as a whole: how it starts, how it develops across the issues and story arcs, and where it leaves things. " +
        "Mention issue numbers in parentheses where it helps, e.g. (#3). Spoilers are fine. If some issues have no synopsis, don't guess what happens in them.",
    },
    {
      role: "user",
      content: `${series}${publisher ? ` (${publisher})` : ""}, issues #${issues[0].number}–#${issues[issues.length - 1].number}:\n\n${listing}`,
    },
  ];

  let text;
  try {
    const out = await env.AI.run(SUMMARY_MODEL, { messages, max_tokens: 800, temperature: 0.3 });
    text = String(out?.response ?? "").trim();
  } catch (e) {
    return json({ error: "The AI overview failed. Try again in a moment." }, 502);
  }
  if (!text) return json({ error: "The AI returned an empty overview. Try again." }, 502);

  const res = json({ summary: text, model: SUMMARY_MODEL }, 200, { "cache-control": `public, max-age=${CACHE_SECONDS}` });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Issues whose Metron synopsis is missing or thin: let the model use its own
// knowledge, but only where it is confident, one line per issue.
async function gaps(env, ctx, cache, cacheKey, series, publisher, issues, listing) {
  const messages = [
    {
      role: "system",
      content:
        "You are a careful comics historian. For each listed issue, write a 1-2 sentence plot summary from your own knowledge of that published comic. " +
        "Describe an issue ONLY if you are confident you know that specific issue of that specific series and volume (the year in brackets identifies the volume). " +
        "If you are not confident, write UNKNOWN. Never guess, and never pad a thin synopsis with invented detail. " +
        "Any text already given for an issue (often a short publisher teaser) is context, not something to repeat. " +
        "Output exactly one line per issue in the form `#<number>: <summary or UNKNOWN>` and nothing else.",
    },
    {
      role: "user",
      content: `${series}${publisher ? ` (${publisher})` : ""}. Issues with missing or thin synopses:\n\n${listing}`,
    },
  ];
  let text;
  try {
    const out = await env.AI.run(SUMMARY_MODEL, { messages, max_tokens: 900, temperature: 0.1 });
    text = String(out?.response ?? "");
  } catch (e) {
    return json({ error: "The AI couldn't fill the gaps. Try again in a moment." }, 502);
  }
  const wanted = new Map(issues.map((i) => [i.number.toLowerCase(), i.number]));
  const found = new Map();
  for (const line of text.split("\n")) {
    const m = line.replace(/[*`]/g, "").trim().match(/^#?\s*([^\s:]+)\s*[:\-–]\s*(.+)$/);
    if (!m) continue;
    const num = wanted.get(m[1].toLowerCase());
    const body = m[2].trim();
    if (!num || found.has(num)) continue;
    found.set(num, /^unknown\b/i.test(body) ? "" : body.slice(0, 600));
  }
  const result = issues.map((i) => ({ number: i.number, text: found.get(i.number) || "" }));
  const res = json({ gaps: result, model: SUMMARY_MODEL, source: "model-knowledge" }, 200, {
    "cache-control": `public, max-age=${CACHE_SECONDS}`,
  });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slimIssue(i) {
  return {
    id: i.id,
    number: i.number,
    name: i.issue || "",
    series: i.series?.name || "",
    seriesId: i.series?.id,
    coverDate: i.cover_date || null,
    storeDate: i.store_date || null,
    image: i.image || null,
  };
}

const base = (env) => (env.METRON_BASE || "https://metron.cloud/api/").replace(/\/?$/, "/");

async function metron(env, path, params) {
  const u = new URL(path, base(env));
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  return metronUrl(env, u.toString());
}

async function metronUrl(env, href) {
  const r = await fetch(href, {
    headers: {
      Authorization: `Bearer ${env.METRON_TOKEN}`,
      Accept: "application/json",
      "User-Agent": "LongboxArcFinder/1.0 (Cloudflare Worker)",
    },
  });
  if (r.status === 401 || r.status === 403) throw httpError(502, "Metron rejected the token. Check the METRON_TOKEN secret.");
  if (r.status === 404) throw httpError(404, "Metron has no record of that.");
  if (r.status === 429) throw httpError(429, "Metron's rate limit was hit. Wait a minute and try again.");
  if (!r.ok) throw httpError(502, `Metron returned an error (${r.status}).`);
  return r.json();
}

// Follow Metron's paginated `next` links, up to maxPages pages.
async function metronAll(env, path, params, maxPages) {
  let page = await metron(env, path, params);
  const out = [...(page.results || [])];
  let n = 1;
  while (page.next && n < maxPages) {
    page = await metronUrl(env, page.next);
    out.push(...(page.results || []));
    n++;
  }
  return out;
}

const isId = (s) => /^\d+$/.test(s || "");
const httpError = (status, message) => Object.assign(new Error(message), { status });
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
