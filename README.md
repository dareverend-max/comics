# Longbox Arc Finder

A Cloudflare Worker web app that uses the [Metron](https://metron.cloud) comic database to:

1. **Summarize a run**: enter a title, publisher and start/end issue numbers to get each issue's synopsis, credits and the story arcs it belongs to.
2. **Find where an arc ends**: enter one issue number to see its arc, which part it is, the issues still to read (including tie-ins from other series), and the issue and date where the arc finishes.

The Worker serves the page and calls Metron on the server, so your Metron token stays a Cloudflare secret and never reaches the browser. Metron answers are cached at the edge for 12 hours.

## Deploy from the Cloudflare dashboard (no tools needed)

1. **Workers & Pages → Create → Create Worker** (Start with Hello World), name it `longbox-arc-finder`, **Deploy**.
2. **Edit code**, delete everything, paste the whole of [`worker.js`](worker.js), **Deploy**.
3. **Settings → Variables and Secrets → Add**, type **Secret**, name `METRON_TOKEN`, value = the API token from your metron.cloud account page. Save.
4. Open `https://longbox-arc-finder.<your-subdomain>.workers.dev`.

## Or deploy with Wrangler

```bash
npm install
npx wrangler secret put METRON_TOKEN
npm run deploy
```

## Editing

Edit `src/index.html` (the page) or `src/worker.template.js` (the API), then run `node build.mjs` to regenerate `worker.js`.

Metron allows about 30 requests a minute, so one run summarizes at most 25 issues.
