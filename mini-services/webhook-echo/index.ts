/// <reference types="bun-types" />
// webhook-echo — records every POST to any path and lets you inspect deliveries
// via GET /deliveries. In-memory only (cap 200, newest first). Intended for local
// E2E testing of the app's outbound webhook dispatcher. NOT for production use.

type Delivery = {
  id: string;
  ts: string;
  path: string;
  contentType: string | null;
  signature: string | null;
  body: string;
  parsed: unknown;
};

const PORT = 3030;
const MAX_DELIVERIES = 200;

const deliveries: Delivery[] = [];

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return json({ ok: true });
    }

    if (req.method === "POST" && path === "/clear") {
      deliveries.length = 0;
      return json({ ok: true });
    }

    if (req.method === "GET" && path === "/deliveries") {
      // deliveries are stored newest-first (unshift on insert)
      return json({ count: deliveries.length, deliveries: [...deliveries] });
    }

    if (req.method === "POST") {
      const body = await req.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null; // not JSON
      }
      const delivery: Delivery = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        path,
        contentType: req.headers.get("content-type"),
        signature: req.headers.get("x-signature"),
        body,
        parsed,
      };
      deliveries.unshift(delivery);
      if (deliveries.length > MAX_DELIVERIES) deliveries.pop();
      return json({ received: true, id: delivery.id });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`[webhook-echo] HTTP listening on :${PORT}`);

// Make this file an ES module so top-level declarations stay file-scoped.
export {};
