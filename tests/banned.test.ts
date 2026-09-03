import { describe, expect, test } from "bun:test";
import { AccountPool, FreebuffAccount, type PoolNotification } from "../src/freebuff/pool";
import type { SessionState, UpstreamClient } from "../src/freebuff/upstream";
import { UpstreamError } from "../src/freebuff/upstream";
import { maskToken } from "../src/config";

/**
 * Ban handling: any upstream answer with {"status":"banned"} must permanently remove
 * the account from the pool and persist the removal (onAccountsChanged), and the
 * adapter-level helper (AccountPool.isBannedBody) must recognize the body shapes the
 * upstream actually returns.
 */

function makeAccount(name: string, client: UpstreamClient): FreebuffAccount {
  return new FreebuffAccount({
    name,
    token: `token-${name}`,
    maskedToken: maskToken(`token-${name}`),
    client,
    rotationIntervalMs: 6 * 60 * 60 * 1000,
    requestTimeoutMs: 30_000,
  });
}

describe("banned account handling", () => {
  test("isBannedBody recognizes the upstream ban bodies", () => {
    expect(AccountPool.isBannedBody(403, '{"status":"banned"}')).toBe(true);
    expect(AccountPool.isBannedBody(401, '{"status":"banned"}')).toBe(true);
    expect(AccountPool.isBannedBody(403, '{"status":"banned"}\n')).toBe(true);
    expect(AccountPool.isBannedBody(403, '{"error":"free_mode_cli_required"}')).toBe(false);
    expect(AccountPool.isBannedBody(403, "")).toBe(false);
    expect(AccountPool.isBannedBody(403, "not json")).toBe(false);
    expect(AccountPool.isBannedBody(200, '{"status":"banned"}')).toBe(false);
  });

  test("parseRateLimited reads the daily/weekly quota refusal", () => {
    const body = JSON.stringify({
      status: "rate_limited",
      period: "pacific_day",
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
      limit: 12,
      recentCount: 12,
    });
    const parsed = AccountPool.parseRateLimited(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.period).toBe("pacific_day");
    expect(parsed!.limit).toBe(12);
    expect(parsed!.resetAtMs).toBeGreaterThan(Date.now());

    expect(AccountPool.parseRateLimited('{"status":"banned"}')).toBeNull();
    expect(AccountPool.parseRateLimited("garbage")).toBeNull();
  });

  test("rate_limited admission cools the account down until reset (not removal)", async () => {
    const client = {
      startRun: async () => "run_1",
      finishRun: async () => {},
      createOrRefreshSession: async (): Promise<SessionState> => {
        throw new UpstreamError(JSON.stringify({
          status: "rate_limited",
          period: "pacific_day",
          resetAt: new Date(Date.now() + 60_000).toISOString(),
          limit: 10,
        }), 429);
      },
      getSession: async (): Promise<SessionState> => {
        throw new UpstreamError("nope", 500);
      },
      endSession: async () => {},
      chatCompletions: async () => ({ response: new Response("{}", { status: 200 }) }),
    } as unknown as UpstreamClient;

    const account = makeAccount("account-1", client);
    const pool = new AccountPool([account]);
    let persisted = 0;
    pool.onAccountsChanged = () => { persisted += 1; };
    const notes: PoolNotification[] = [];
    pool.subscribe(n => notes.push(n));

    await expect(account.acquire("base2-free", "z-ai/glm-5.3-flash")).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 20));

    // NOT removed — it comes back at reset.
    expect(account.isBanned).toBe(false);
    expect(pool.size).toBe(1);
    expect(persisted).toBe(0);
    expect(account.unavailableReason()).toContain("cooling down");
    expect(notes.some(n => n.kind === "cooldown" && n.level === "warn")).toBe(true);
  });

  test("markBanned notifies, cools down and triggers pool removal + persistence", async () => {
    const client = {
      startRun: async () => "run_1",
      finishRun: async () => {},
      createOrRefreshSession: async (): Promise<SessionState> => ({
        status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      getSession: async (): Promise<SessionState> => ({
        status: "active", instanceId: "inst-1", position: 0, queueDepth: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      endSession: async () => {},
      chatCompletions: async () => ({ response: new Response("{}", { status: 200 }) }),
    } as unknown as UpstreamClient;

    const a1 = makeAccount("account-1", client);
    const a2 = makeAccount("account-2", client);
    const pool = new AccountPool([a1, a2]);

    let persisted = 0;
    pool.onAccountsChanged = () => { persisted += 1; };
    const notes: PoolNotification[] = [];
    pool.subscribe(n => notes.push(n));

    a1.markBanned("banned (chat completion)");

    // Removal is async (graceful shutdown of the account) — let the microtask queue run.
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(pool.size).toBe(1);
    expect(pool.listAccounts()[0]!.name).toBe("account-2");
    expect(persisted).toBe(1);
    expect(a1.isBanned).toBe(true);
    expect(notes.some(n => n.kind === "account_removed" && n.account === "account-1" && n.level === "error")).toBe(true);

    // Double-marking is idempotent: no second removal or persistence.
    a1.markBanned("banned again");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pool.size).toBe(1);
    expect(persisted).toBe(1);
  });

  test("session admission answering banned throws and removes the account", async () => {
    let sessionCalls = 0;
    const client = {
      startRun: async () => "run_1",
      finishRun: async () => {},
      createOrRefreshSession: async (): Promise<SessionState> => {
        sessionCalls += 1;
        throw new UpstreamError('{"status":"banned"}', 403);
      },
      getSession: async (): Promise<SessionState> => {
        throw new UpstreamError('{"status":"banned"}', 403);
      },
      endSession: async () => {},
      chatCompletions: async () => ({ response: new Response("{}", { status: 200 }) }),
    } as unknown as UpstreamClient;

    const account = makeAccount("account-1", client);
    const pool = new AccountPool([account]);
    let persisted = 0;
    pool.onAccountsChanged = () => { persisted += 1; };

    await expect(account.acquire("base2-free", "z-ai/glm-5.3-flash")).rejects.toThrow("banned");
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(account.isBanned).toBe(true);
    expect(pool.size).toBe(0);
    expect(persisted).toBe(1);
  });
});
