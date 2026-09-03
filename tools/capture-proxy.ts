// Transparent logging proxy: forwards everything to www.codebuff.com and appends
// one JSON line per request (method, path, headers, parsed body) to the output file.
const UPSTREAM = "https://www.codebuff.com";
const OUT = process.env.CAPTURE_OUT || "/tmp/capture.jsonl";
import { appendFileSync } from "node:fs";

Bun.serve({
  port: 17998,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("host");
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "DELETE") {
      // Bun auto-decompresses request bodies; forward plain and drop encoding headers.
      body = await req.text();
    }
    let parsedBody: unknown = null;
    if (body) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = `<non-json ${body.length}b>`;
      }
    }
    try {
      appendFileSync(OUT, JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(headers),
        body: parsedBody,
      }) + "\n");
    } catch {}
    const fwd = new Headers(headers);
    fwd.delete("content-encoding");
    fwd.delete("content-length");
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers: fwd,
      ...(body !== undefined ? { body } : {}),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  },
});
console.log(`capture proxy on :17998 -> ${UPSTREAM}, logging to ${OUT}`);
