import { afterEach, describe, expect, test } from "bun:test";
import { createRuntime, handleRequest, refreshProviderModels } from "../src/server";
import type { CommandCodexConfig } from "../src/config";

function testConfig(overrides: Partial<CommandCodexConfig> = {}): CommandCodexConfig {
  return {
    version: 1,
    host: "127.0.0.1",
    port: 17999,
    apiKey: "cc-test-key",
    requestTimeoutMs: 15 * 60 * 1000,
    apiKeys: [],
    httpProxy: "",
    ...overrides,
  };
}

/** Default offline stub: provider fetch fails → deterministic fallback catalog. */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as unknown as typeof fetch;
}
function stubOfflineProviderFetch(): void {
  stubFetch(() => new Response("offline", { status: 404 }));
}

describe("GET /v1/models", () => {
  test("serves fallback rows when the provider catalog fetch fails", async () => {
    stubOfflineProviderFetch();
    const runtime = createRuntime(testConfig());
    await refreshProviderModels(runtime);
    const response = await handleRequest(new Request("http://bridge/v1/models"), runtime);
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<{ slug: string; visibility: string; display_name: string }> };
    const slugs = body.models.map(model => model.slug);
    expect(slugs).toContain("commancodex/claude-opus-5");
    expect(slugs).toContain("commancodex/gpt-5.6-luna");
    expect(slugs.every(slug => slug.startsWith("commancodex/"))).toBe(true);
    expect(body.models.every(model => model.visibility === "list")).toBe(true);
    expect(body.models.every(model => model.display_name.startsWith("Commancodex — "))).toBe(true);
  });

  test("serves the live provider catalog when the key works", async () => {
    stubFetch(url => {
      if (url.includes("/provider/v1/models")) {
        return Response.json({
          data: [
            { id: "claude-opus-5", name: "Claude Opus 5", context_length: 1_000_000 },
            { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1_050_000 },
          ],
        });
      }
      return new Response("nope", { status: 404 });
    });
    const runtime = createRuntime(testConfig());
    await refreshProviderModels(runtime);
    const response = await handleRequest(new Request("http://bridge/v1/models"), runtime);
    const body = await response.json() as { models: Array<{ slug: string; context_window: number }> };
    const opus = body.models.find(model => model.slug === "commancodex/claude-opus-5");
    expect(opus?.context_window).toBe(1_000_000);
    expect(body.models).toHaveLength(2);
  });
});

describe("auth middleware", () => {
  test("rejects requests when apiKeys are configured and none matches", async () => {
    const runtime = createRuntime(testConfig({ apiKeys: ["secret-key"] }));
    const response = await handleRequest(new Request("http://bridge/v1/models"), runtime, "10.0.0.9");
    expect(response.status).toBe(401);
    const ok = await handleRequest(
      new Request("http://bridge/v1/models", { headers: { authorization: "Bearer secret-key" } }),
      runtime,
      "10.0.0.9",
    );
    expect(ok.status).toBe(200);
  });

  test("loopback clients bypass the API key entirely", async () => {
    const runtime = createRuntime(testConfig({ apiKeys: ["secret-key"] }));
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const response = await handleRequest(new Request("http://bridge/healthz"), runtime, ip);
      expect(response.status).toBe(200);
    }
  });
});

describe("routing", () => {
  test("unknown paths 404 and unsupported models 400", async () => {
    stubOfflineProviderFetch();
    const runtime = createRuntime(testConfig());
    await refreshProviderModels(runtime);
    expect((await handleRequest(new Request("http://bridge/nope"), runtime)).status).toBe(404);
    const bad = await handleRequest(
      new Request("http://bridge/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "some-other/model", input: "hi", stream: false }),
      }),
      runtime,
    );
    expect(bad.status).toBe(400);
  });

  test("healthz reports the provider and live-catalog state", async () => {
    stubOfflineProviderFetch();
    const runtime = createRuntime(testConfig());
    await refreshProviderModels(runtime);
    const response = await handleRequest(new Request("http://bridge/healthz"), runtime);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; provider: string; liveCatalog: boolean; models: number };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("commandcode.ai");
    expect(body.liveCatalog).toBe(false);
    expect(body.models).toBeGreaterThan(0);
  });
});

describe("POST /key/validate", () => {
  test("validates a key without persisting it", async () => {
    stubFetch(url => {
      if (url.includes("/provider/v1/models")) return Response.json({ data: [{ id: "claude-opus-5" }] });
      return new Response("nope", { status: 404 });
    });
    const runtime = createRuntime(testConfig());
    const response = await handleRequest(
      new Request("http://bridge/key/validate", { method: "POST", body: JSON.stringify({ apiKey: "another-key" }) }),
      runtime,
    );
    const body = await response.json() as { valid: boolean; models: number };
    expect(body.valid).toBe(true);
    expect(body.models).toBe(1);
  });
});
