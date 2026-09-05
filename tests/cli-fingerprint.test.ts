import { describe, expect, test } from "bun:test";
import { AccountPool, FreebuffAccount, WaitingRoomError, type PoolNotification } from "../src/freebuff/pool";
import type { SessionState, UpstreamClient } from "../src/freebuff/upstream";
import { maskToken } from "../src/config";

/**
 * CLI-fingerprint conformance: buffcodex must speak the freebuff CLI's session contract —
 * x-freebuff-model on session POST, rejoin (end + re-POST) when the model changes, and
 * x-freebuff-acting-user-id on chat-completions. Without these the upstream rejects direct
 * API calls with 403 free_mode_cli_required.
 */

interface FakeClient {
  client: UpstreamClient;
  sessionPosts: Array<string | undefined>; // model header per POST
  sessionGets: number;
  endSessions: number;
  chatCalls: Array<string | undefined>; // acting-user id per chat call
  userIdFetches: number;
  states: SessionState[];
}

function makeFake(overrides: Partial<FakeClient> = {}): FakeClient {
  const fake: FakeClient = {
    client: {} as UpstreamClient,
    sessionPosts: [],
    sessionGets: 0,
    endSessions: 0,
    chatCalls: [],
    userIdFetches: 0,
    states: [],
    ...overrides,
  };
  fake.client = {
    startRun: async () => `run_${Math.random().toString(36).slice(2, 8)}`,
    finishRun: async () => {},
    createOrRefreshSession: async (_token: string, options?: { model?: string }) => {
      fake.sessionPosts.push(options?.model);
      return fake.states.length > 0
        ? fake.states.shift()!
        : { status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(), model: options?.model };
    },
    getSession: async () => {
      fake.sessionGets += 1;
      return { status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    endSession: async () => {
      fake.endSessions += 1;
    },
    getUserId: async () => {
      fake.userIdFetches += 1;
      return "user-abc-123";
    },
    chatCompletions: async (_token: string, _body: unknown, _signal?: AbortSignal, actingUserId?: string) => {
      fake.chatCalls.push(actingUserId);
      return { response: new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n", { status: 200 }) };
    },
  } as unknown as UpstreamClient;
  return fake;
}

function makeAccount(name: string, fake: FakeClient): FreebuffAccount {
  return new FreebuffAccount({
    name,
    token: `token-${name}`,
    maskedToken: maskToken(`token-${name}`),
    client: fake.client,
    rotationIntervalMs: 6 * 60 * 60 * 1000,
    requestTimeoutMs: 30_000,
  });
}

describe("CLI fingerprint: session contract", () => {
  test("session POST sends x-freebuff-model with the requested model", async () => {
    const fake = makeFake();
    const account = makeAccount("account-1", fake);
    const pool = new AccountPool([account]);

    await pool.acquire("base2-free", "z-ai/glm-5.3-flash", new AbortController().signal);
    expect(fake.sessionPosts).toEqual(["z-ai/glm-5.3-flash"]);
    await pool.shutdown();
  });

  test("session without a model sends no x-freebuff-model (legacy paths)", async () => {
    const fake = makeFake();
    const account = makeAccount("account-1", fake);
    const pool = new AccountPool([account]);

    await pool.acquire("base2-free", undefined, new AbortController().signal);
    expect(fake.sessionPosts).toEqual([undefined]);
    await pool.shutdown();
  });

  test("model switch rejoins: ends the old session and re-POSTs with the new model", async () => {
    const fake = makeFake();
    const account = makeAccount("account-1", fake);
    const pool = new AccountPool([account]);

    // Acquires serialize per account now: each lease is released before the next
    // acquire, mirroring the adapter's one-completion-at-a-time contract.
    const first = await pool.acquire("base2-free", "z-ai/glm-5.3-flash", new AbortController().signal);
    expect(fake.sessionPosts).toEqual(["z-ai/glm-5.3-flash"]);
    expect(fake.endSessions).toBe(0);
    await first.lease.release();

    // Same model again: no rejoin.
    const second = await pool.acquire("base2-free", "z-ai/glm-5.3-flash", new AbortController().signal);
    expect(fake.endSessions).toBe(0);
    expect(fake.sessionPosts).toHaveLength(1);
    await second.lease.release();

    // Different model: end + re-POST with the new model.
    const third = await pool.acquire("base2-free", "openai/gpt-5.6-luna", new AbortController().signal);
    expect(fake.endSessions).toBe(1);
    expect(fake.sessionPosts).toEqual(["z-ai/glm-5.3-flash", "openai/gpt-5.6-luna"]);
    await third.lease.release();
    await pool.shutdown();
  });

  test("chat-completions sends x-freebuff-acting-user-id from GET /api/v1/me (cached)", async () => {
    const fake = makeFake();
    const account = makeAccount("account-1", fake);
    const pool = new AccountPool([account]);

    await account.chat({ model: "x" }, new AbortController().signal);
    await account.chat({ model: "x" }, new AbortController().signal);
    expect(fake.chatCalls).toEqual(["user-abc-123", "user-abc-123"]);
    expect(fake.userIdFetches).toBe(1); // cached after the first fetch
    await pool.shutdown();
  });

  test("userId fetch failure is non-fatal: chat proceeds without the header", async () => {
    const fake = makeFake({ userIdFetches: 0 });
    fake.client = {
      ...fake.client,
      getUserId: async () => {
        fake.userIdFetches += 1;
        throw new Error("me endpoint down");
      },
    } as unknown as UpstreamClient;
    const account = makeAccount("account-1", fake);

    const result = await account.chat({ model: "x" }, new AbortController().signal);
    expect(fake.chatCalls).toEqual([undefined]);
    expect("response" in result).toBe(true);
  });

  test("waiting-room queueing still works with a model attached", async () => {
    const fake = makeFake();
    fake.states.push({ status: "queued", instanceId: "inst-q", position: 2, queueDepth: 5 });
    const account = makeAccount("account-1", fake);
    const pool = new AccountPool([account]);

    let caught: WaitingRoomError | undefined;
    try {
      await pool.acquire("base2-free", "z-ai/glm-5.3-flash", new AbortController().signal);
    } catch (error) {
      if (error instanceof WaitingRoomError) caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught!.position).toBe(2);
    expect(fake.sessionPosts).toEqual(["z-ai/glm-5.3-flash"]);
    await pool.shutdown();
  });
});
