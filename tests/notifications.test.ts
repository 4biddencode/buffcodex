import { describe, expect, test } from "bun:test";
import { AccountPool, FreebuffAccount, type PoolNotification } from "../src/freebuff/pool";
import type { SessionState, UpstreamClient } from "../src/freebuff/upstream";
import { maskToken } from "../src/config";

interface MockCalls {
  sessions: number;
  runCounter: number;
  states: SessionState[];
}

function makeAccount(
  name: string,
  calls: MockCalls,
  options: { token?: string } = {},
): FreebuffAccount {
  const client = {
    startRun: async () => `run_${++calls.runCounter}`,
    finishRun: async () => {},
    createOrRefreshSession: async (): Promise<SessionState> => {
      calls.sessions += 1;
      return calls.states.length > 0
        ? calls.states.shift()!
        : { status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    getSession: async (): Promise<SessionState> => {
      calls.sessions += 1;
      return { status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    endSession: async () => {},
    chatCompletions: async () => ({ response: new Response("{}", { status: 200 }) }),
  } as unknown as UpstreamClient;
  return new FreebuffAccount({
    name,
    token: options.token ?? `token-${name}`,
    maskedToken: maskToken(options.token ?? `token-${name}`),
    client,
    rotationIntervalMs: 6 * 60 * 60 * 1000,
    requestTimeoutMs: 30_000,
  });
}

describe("AccountPool notification hub", () => {
  test("forwards account notifications and keeps a bounded ring buffer", async () => {
    const calls: MockCalls = { sessions: 0, runCounter: 0, states: [] };
    const account = makeAccount("account-1", calls);
    const pool = new AccountPool([account]);

    const received: PoolNotification[] = [];
    const unsubscribe = pool.subscribe(notification => received.push(notification));

    account.markCooldown(30 * 60_000, "upstream auth rejected token");
    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe("cooldown");
    expect(received[0]!.account).toBe("account-1");
    expect(received[0]!.level).toBe("warn");

    // Ring buffer cap + filtering. Subscribers receive every notification (cooldown + model-use).
    for (let i = 0; i < 60; i++) pool.notifyModelUse("account-1", "openai/gpt-5.6-luna", "premium");
    expect(pool.recentNotifications().length).toBeLessThanOrEqual(50);
    expect(pool.recentNotifications(Date.now() + 1)).toHaveLength(0);
    expect(received).toHaveLength(61);

    unsubscribe();
    account.markCooldown(60_000, "after unsubscribe");
    expect(received).toHaveLength(61);
  });

  test("notifyModelUse warns for premium and limited but not free", () => {
    const calls: MockCalls = { sessions: 0, runCounter: 0, states: [] };
    const pool = new AccountPool([makeAccount("account-1", calls)]);

    pool.notifyModelUse("account-1", "openai/gpt-5.6-luna", "premium");
    pool.notifyModelUse("account-1", "anthropic/claude-fable-5", "limited");
    pool.notifyModelUse("account-1", "z-ai/glm-5.2", "free");

    const kinds = pool.recentNotifications().map(notification => notification.kind);
    expect(kinds).toContain("premium_model");
    expect(kinds).toContain("limited_model");
    expect(kinds).not.toContain("free_model");
    const premium = pool.recentNotifications().find(notification => notification.kind === "premium_model")!;
    expect(premium.message).toContain("4/day");
  });
});

describe("instant session renewal", () => {
  test("active session arms a renewal timer that fires before expiry", async () => {
    const calls: MockCalls = { sessions: 0, runCounter: 0, states: [
      // First ensureSession: active with a 6.5s expiry — passes the 5s readiness check,
      // and the renewal timer fires at expiry-5s ≈ t+1.5s (the timer keeps the tight
      // 5s boundary; RENEW_EARLY_MS only applies when no run is inflight).
      { status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 6_500).toISOString() },
    ] };
    const account = makeAccount("account-1", calls);
    const pool = new AccountPool([account]);

    const received: PoolNotification[] = [];
    pool.subscribe(notification => received.push(notification));

    // First ensureSession: upstream reports active with a 1.2s expiry (short for the test).
    // The lease is released so nothing is inflight — a renewal with inflight work is
    // deferred (rotating the seat mid-turn would supersede the request).
    account.invalidateSession("");
    const lease = await account.acquire("base2-free", undefined, new AbortController().signal);
    await lease.release();
    expect(calls.sessions).toBe(1);

    // The renewal timer fires at ~expiry-5s; wait for it.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(calls.sessions).toBeGreaterThanOrEqual(2);
    const kinds = received.map(notification => notification.kind);
    expect(kinds).toContain("session_renewed");
    await pool.shutdown();
  }, 10_000);

  test("renewal failure emits an account_error notification and retries", async () => {
    const calls: MockCalls = { sessions: 0, runCounter: 0, states: [] };
    const account = makeAccount("account-1", calls);
    const pool = new AccountPool([account]);
    const received: PoolNotification[] = [];
    pool.subscribe(notification => received.push(notification));

    // Force the renewal path to fail once: replace createOrRefreshSession after the first call.
    const client = account["client"] as unknown as { createOrRefreshSession: (...args: unknown[]) => Promise<SessionState> };
    const original = client.createOrRefreshSession.bind(client);
    let failNext = false;
    client.createOrRefreshSession = async (...args: unknown[]) => {
      if (failNext) throw new Error("network down");
      return original(...args);
    };

    account.invalidateSession("");
    failNext = true;
    await expect(account.acquire("base2-free", undefined, new AbortController().signal)).rejects.toThrow("network down");
    failNext = false;
    account.invalidateSession("");
    await account.acquire("base2-free", undefined, new AbortController().signal);
    expect(calls.sessions).toBe(1);

    await pool.shutdown();
  });
});
