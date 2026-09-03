import { afterEach, describe, expect, test } from "bun:test";
import { createRuntime, handleRequest } from "../src/server";
import type { BuffcodexConfig } from "../src/config";

function testConfig(overrides: Partial<BuffcodexConfig> = {}): BuffcodexConfig {
  return {
    version: 1,
    host: "127.0.0.1",
    port: 17999,
    upstreamBaseUrl: "https://upstream.test",
    authTokens: ["token-a", "token-b"],
    rotationIntervalMs: 6 * 60 * 60 * 1000,
    requestTimeoutMs: 15 * 60 * 1000,
    apiKeys: [],
    httpProxy: "",
    ...overrides,
  };
}

/** Default offline stub: registry fetch fails → deterministic fallback catalog. */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function stubOfflineRegistryFetch(): void {
  globalThis.fetch = (async () => new Response("offline", { status: 404 })) as unknown as typeof fetch;
}

describe("GET /v1/models", () => {
  test("serves a catalog with all fallback models when the registry fetch fails", async () => {
    stubOfflineRegistryFetch();
    const runtime = createRuntime(testConfig());
    await runtime.registry.start();
    runtime.registry.stop();
    const response = await handleRequest(new Request("http://bridge/v1/models"), runtime);
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<{ slug: string; visibility: string }> };
    const slugs = body.models.map(model => model.slug);
    expect(slugs).toContain("minimax/minimax-m3");
    expect(slugs).toContain("z-ai/glm-5.2");
    expect(body.models.every(model => model.visibility === "list")).toBe(true);
  });
});

describe("auth middleware", () => {
  test("rejects requests when apiKeys are configured and none matches", async () => {
    const runtime = createRuntime(testConfig({ apiKeys: ["secret-key"] }));
    const response = await handleRequest(new Request("http://bridge/v1/models"), runtime);
    expect(response.status).toBe(401);
    const ok = await handleRequest(
      new Request("http://bridge/v1/models", { headers: { authorization: "Bearer secret-key" } }),
      runtime,
    );
    expect(ok.status).toBe(200);
  });

  test("LAN exposure gates POSTs and /v1/* but keeps dashboard GETs open", async () => {
    const runtime = createRuntime(testConfig({ host: "0.0.0.0", apiKeys: ["secret-key"] }));
    // Dashboard + read-only status endpoints stay open for the browser.
    expect((await handleRequest(new Request("http://bridge/"), runtime)).status).toBe(200);
    expect((await handleRequest(new Request("http://bridge/usage"), runtime)).status).toBe(200);
    expect((await handleRequest(new Request("http://bridge/healthz"), runtime)).status).toBe(200);
    // Codex-facing surface requires the key.
    expect((await handleRequest(new Request("http://bridge/v1/models"), runtime)).status).toBe(401);
    expect((await handleRequest(new Request("http://bridge/v1/responses", { method: "POST", body: "{}" }), runtime)).status).toBe(401);
    // With the key, /v1/models opens up again.
    const keyed = await handleRequest(
      new Request("http://bridge/v1/models", { headers: { "x-api-key": "secret-key" } }),
      runtime,
    );
    expect(keyed.status).toBe(200);
  });

  test("loopback clients bypass the API key entirely", async () => {
    const runtime = createRuntime(testConfig({ host: "0.0.0.0", apiKeys: ["secret-key"] }));
    const response = await handleRequest(new Request("http://bridge/v1/models"), runtime, "127.0.0.1");
    expect(response.status).toBe(200);
    const v6 = await handleRequest(new Request("http://bridge/v1/models"), runtime, "::1");
    expect(v6.status).toBe(200);
    const remote = await handleRequest(new Request("http://bridge/v1/models"), runtime, "192.168.0.50");
    expect(remote.status).toBe(401);
  });
});

describe("GET /healthz and /usage", () => {
  test("reports per-account snapshots including usage ledger", async () => {
    const runtime = createRuntime(testConfig());
    const health = await (await handleRequest(new Request("http://bridge/healthz"), runtime)).json() as {
      ok: boolean;
      accounts: Array<{ name: string; status: string; usage: { requestCount: number } }>;
    };
    expect(health.ok).toBe(true);
    expect(health.accounts).toHaveLength(2);
    expect(health.accounts.map(account => account.name)).toEqual(["account-1", "account-2"]);

    const account = runtime.pool.findAccount("account-1")!;
    account.recordUsage({ inputTokens: 1_000, outputTokens: 200 });
    account.recordUsage({ inputTokens: 500, outputTokens: 100 });

    const usage = await (await handleRequest(new Request("http://bridge/usage"), runtime)).json() as {
      accounts: Array<{ name: string; usage: { inputTokens: number; outputTokens: number; requestCount: number } }>;
    };
    const first = usage.accounts.find(account => account.name === "account-1")!;
    expect(first.usage.requestCount).toBe(2);
    expect(first.usage.inputTokens).toBe(1_500);
    expect(first.usage.outputTokens).toBe(300);
  });
});

describe("POST /v1/responses", () => {
  test("rejects unsupported models with a 400", async () => {
    stubOfflineRegistryFetch();
    const runtime = createRuntime(testConfig());
    await runtime.registry.start();
    runtime.registry.stop();
    const response = await handleRequest(new Request("http://bridge/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "not-a-model", input: "hi", stream: false }),
      headers: { "content-type": "application/json" },
    }), runtime);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain("unsupported model");
  });

  test("runs a non-streaming turn end-to-end against a mocked upstream", async () => {
    const originalFetch = globalThis.fetch;
    const chatCalls: Array<{ auth?: string; body: any }> = [];
    let runStarted = 0;
    stubOfflineRegistryFetch();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.endsWith("/api/v1/agent-runs")) {
        runStarted += 1;
        return new Response(JSON.stringify({ runId: `run_${runStarted}` }), { status: 200 });
      }
      if (url.endsWith("/api/v1/freebuff/session")) {
        return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });
      }
      if (url.endsWith("/api/v1/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as any;
        chatCalls.push({ auth, body });
        const sse = [
          'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"thinking hard"}}]}',
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          'data: {"choices":[{"delta":{"content":" from freebuff"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}}',
          "data: [DONE]",
        ].join("\n") + "\n";
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const runtime = createRuntime(testConfig());
      await runtime.registry.start();
      runtime.registry.stop();
      const response = await handleRequest(new Request("http://bridge/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "z-ai/glm-5.2", input: "say hi", stream: false }),
        headers: { "content-type": "application/json" },
      }), runtime);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        status: string;
        model: string;
        output: Array<{ type: string; content?: Array<{ text?: string }>; summary?: Array<{ text?: string }> }>;
        usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      };
      expect(body.status).toBe("completed");
      expect(body.model).toBe("z-ai/glm-5.2");
      const message = body.output.find(item => item.type === "message");
      expect(message?.content?.map(part => part.text ?? "").join("")).toBe("Hello from freebuff");
      const reasoning = body.output.find(item => item.type === "reasoning");
      expect(reasoning).toBeDefined();
      expect(body.usage.total_tokens).toBe(150);

      // Upstream contract: metadata injected, account token used.
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]!.auth).toBe("Bearer token-a");
      expect(chatCalls[0]!.body.codebuff_metadata.cost_mode).toBe("free");
      expect(chatCalls[0]!.body.codebuff_metadata.run_id).toBe("run_1");

      // Per-account usage ledger captured the turn.
      const account = runtime.pool.findAccount("account-1")!;
      expect(account.usage.requestCount).toBe(1);
      expect(account.usage.inputTokens).toBe(120);
      expect(account.usage.outputTokens).toBe(30);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streams a Responses SSE turn end-to-end", async () => {
    const originalFetch = globalThis.fetch;
    stubOfflineRegistryFetch();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agent-runs")) {
        return new Response(JSON.stringify({ runId: "run_s1" }), { status: 200 });
      }
      if (url.endsWith("/api/v1/freebuff/session")) {
        return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });
      }
      if (url.endsWith("/api/v1/chat/completions")) {
        const sse = [
          'data: {"choices":[{"delta":{"content":"Hi"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
          "data: [DONE]",
        ].join("\n") + "\n";
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const runtime = createRuntime(testConfig());
      await runtime.registry.start();
      runtime.registry.stop();
      const response = await handleRequest(new Request("http://bridge/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "z-ai/glm-5.2", input: "say hi", stream: true }),
        headers: { "content-type": "application/json" },
      }), runtime);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("response.created");
      expect(text).toContain("response.output_text.delta");
      expect(text).toContain("response.completed");
      expect(text).toContain("data: [DONE]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("round-robins concurrent turns across accounts", async () => {
    const originalFetch = globalThis.fetch;
    const callsByToken = new Map<string, number>();
    let runCounter = 0;
    stubOfflineRegistryFetch();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.endsWith("/api/v1/agent-runs")) {
        runCounter += 1;
        return new Response(JSON.stringify({ runId: `run_${runCounter}` }), { status: 200 });
      }
      if (url.endsWith("/api/v1/freebuff/session")) {
        return new Response(JSON.stringify({ status: "disabled" }), { status: 200 });
      }
      if (url.endsWith("/api/v1/chat/completions")) {
        callsByToken.set(auth, (callsByToken.get(auth) ?? 0) + 1);
        const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n';
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const runtime = createRuntime(testConfig());
      await runtime.registry.start();
      runtime.registry.stop();
      const requests = [1, 2, 3, 4].map(() => handleRequest(new Request("http://bridge/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "z-ai/glm-5.2", input: "go", stream: false }),
        headers: { "content-type": "application/json" },
      }), runtime).then(response => response.json()));
      const responses = await Promise.all(requests);
      expect(responses.every(body => (body as { status: string }).status === "completed")).toBe(true);
      // Two accounts, four sequential-ish requests → each account serves at least one.
      expect(callsByToken.get("Bearer token-a") ?? 0).toBeGreaterThanOrEqual(1);
      expect(callsByToken.get("Bearer token-b") ?? 0).toBeGreaterThanOrEqual(1);
      expect([...callsByToken.values()].reduce((a, b) => a + b, 0)).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
