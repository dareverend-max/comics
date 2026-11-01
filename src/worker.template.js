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
