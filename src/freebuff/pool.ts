/**
 * Multi-account pool — TS port of Freebuff2API's run_manager.go with per-account usage accounting.
 * Each account (auth token) owns: its current agent runs, its free session, cooldown state,
 * and a rolling usage ledger used by the launcher's per-account usage panel.
 */
import type { CachedSession, SessionState, UpstreamClient } from "./upstream";
import { parseOptionalTimeMs, queuedPollDelayMs, UpstreamError } from "./upstream";
import { PREMIUM_SESSION_LIMIT, type ModelTier } from "./models";

export interface QueuedInfo {
  position: number;
  queueDepth: number;
  retryAfterMs: number;
}

export type NotificationKind =
  | "session_renewed"
  | "session_queued"
  | "premium_model"
  | "limited_model"
  | "cooldown"
  | "account_error";

export interface PoolNotification {
  id: string;
  atMs: number;
  level: "info" | "warn" | "error";
  kind: NotificationKind;
  account?: string;
  modelId?: string;
  message: string;
}

const MAX_NOTIFICATIONS = 50;

/** Renew this long before upstream expiry so long turns never straddle the boundary. */
const RENEW_EARLY_MS = 60_000;

function notificationId(): string {
  return crypto.randomUUID();
}

export class WaitingRoomError extends Error {
  readonly accountName: string;
  readonly position: number;
  readonly queueDepth: number;
  readonly retryAfterMs: number;
  constructor(info: QueuedInfo & { accountName: string }) {
    super(
      `freebuff waiting room queued for ${info.accountName}`
      + ` (position ${info.position}/${Math.max(info.queueDepth, info.position)})`
      + `, retry in about ${Math.round(info.retryAfterMs / 1000)}s`,
    );
    this.name = "WaitingRoomError";
    this.accountName = info.accountName;
    this.position = info.position;
    this.queueDepth = info.queueDepth;
    this.retryAfterMs = info.retryAfterMs;
  }
}

interface ManagedRun {
  id: string;
  agentId: string;
  startedAtMs: number;
  inflight: number;
  requestCount: number;
  finishing: boolean;
}

export interface AccountUsage {
  /** Requests served by this account since process start. */
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Epoch ms of the most recent request served. */
  lastRequestAtMs?: number;
  /** Upstream-reported usage window, when available (e.g. rate-limit reset info). */
  window?: Record<string, unknown>;
}

export interface AccountSnapshot {
  name: string;
  /** Truncated display form of the token. */
  maskedToken: string;
  coolingDownUntilMs: number;
  lastError: string;
  session: {
    status: string;
    instanceId: string;
    expiresAtMs: number;
    position: number;
    queueDepth: number;
  } | null;
  runs: Array<{ agentId: string; runId: string; startedAtMs: number; inflight: number; requestCount: number }>;
  drainingRuns: number;
  usage: AccountUsage;
  /** Free-tier remaining requests this window, when upstream exposes it. */
  remainingRequests?: number;
}

interface AccountOptions {
  name: string;
  token: string;
  maskedToken: string;
  client: UpstreamClient;
  rotationIntervalMs: number;
  requestTimeoutMs: number;
}

export class FreebuffAccount {
  readonly name: string;
  readonly maskedToken: string;
  private readonly token: string;
  private readonly client: UpstreamClient;
  private readonly rotationIntervalMs: number;
  private readonly requestTimeoutMs: number;

  private readonly runs = new Map<string, ManagedRun>();
  private draining: ManagedRun[] = [];
  private session: CachedSession | null = null;
  /** The model the active/queued session was admitted for (CLI sends x-freebuff-model on POST). */
  private sessionModel: string | undefined;
  /** Tail of a promise chain serializing every session mutation (see lockedSessionOp). */
  private sessionLock: Promise<unknown> = Promise.resolve();
  /** Acting-user id from GET /api/v1/me — cached forever (stable per token). */
  private userId: string | undefined;
  private cooldownUntilMs = 0;
  private lastError = "";
  /** Armed timer that renews the free session just before upstream expiry. */
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed timer that re-polls a queued (waiting-room) session. */
  private queuedTimer: ReturnType<typeof setTimeout> | null = null;
  private notify: (notification: PoolNotification) => void = () => {};

  readonly usage: AccountUsage = { requestCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  constructor(options: AccountOptions) {
    this.name = options.name;
    this.maskedToken = options.maskedToken;
    this.token = options.token;
    this.client = options.client;
    this.rotationIntervalMs = options.rotationIntervalMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  get isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntilMs;
  }

  /** Active free-session instance id, or null (used for lease metadata). */
  getSessionInstanceId(): string | null {
    return this.session?.instanceId || null;
  }

  /** Reason the account cannot serve a request right now, or null when available. */
  unavailableReason(now = Date.now()): string | null {
    if (now < this.cooldownUntilMs) {
      return `cooling down until ${new Date(this.cooldownUntilMs).toISOString()}`;
    }
    if (this.session?.status === "queued") {
      return "waiting room";
    }
    return null;
  }

  snapshot(): AccountSnapshot {
    return {
      name: this.name,
      maskedToken: this.maskedToken,
      coolingDownUntilMs: this.cooldownUntilMs,
      lastError: this.lastError,
      session: this.session
        ? {
          status: this.session.status,
          instanceId: this.session.instanceId,
          expiresAtMs: this.session.expiresAtMs,
          position: this.session.position,
          queueDepth: this.session.queueDepth,
        }
        : null,
      runs: [...this.runs.values()].map(run => ({
        agentId: run.agentId,
        runId: run.id,
        startedAtMs: run.startedAtMs,
        inflight: run.inflight,
        requestCount: run.requestCount,
      })),
      drainingRuns: this.draining.length,
      usage: { ...this.usage },
    };
  }

  recordUsage(delta: { inputTokens: number; outputTokens: number; totalTokens?: number }): void {
    this.usage.requestCount += 1;
    this.usage.inputTokens += Math.max(0, Math.trunc(delta.inputTokens));
    this.usage.outputTokens += Math.max(0, Math.trunc(delta.outputTokens));
    this.usage.totalTokens += Math.max(0, Math.trunc(delta.totalTokens ?? delta.inputTokens + delta.outputTokens));
    this.usage.lastRequestAtMs = Date.now();
  }

  async acquire(agentId: string, model?: string, signal?: AbortSignal): Promise<AccountLease> {
    if (Date.now() < this.cooldownUntilMs) {
      throw new Error(`${this.name}: cooling down until ${new Date(this.cooldownUntilMs).toISOString()}`);
    }
    await this.ensureUserId(signal);
    // CLI order: the free session is admitted (and heartbeating) BEFORE any agent run
    // starts — runs opened without an active session read as "direct API" upstream.
    await this.ensureSession(model, signal);
    let run = this.runs.get(agentId);
    if (!run || Date.now() - run.startedAtMs >= this.rotationIntervalMs) {
      run = await this.rotateAgent(agentId, signal);
    }
    run = this.runs.get(agentId);
    if (!run) throw new Error(`${this.name}: run missing after rotation`);
    run.inflight += 1;
    run.requestCount += 1;
    return new AccountLease(this, run);
  }

  async rotateAgent(agentId: string, signal?: AbortSignal): Promise<ManagedRun> {
    const runId = await this.client.startRun(this.token, agentId, signal, this.userId || undefined);
    const oldRun = this.runs.get(agentId);
    const run: ManagedRun = { id: runId, agentId, startedAtMs: Date.now(), inflight: 0, requestCount: 0, finishing: false };
    this.runs.set(agentId, run);
    this.lastError = "";
    if (oldRun) {
      this.draining.push(oldRun);
      void this.finishIfReady(oldRun).catch(error => {
        console.warn(`[${this.name}] finish rotated run ${oldRun.id} failed: ${errorText(error)}`);
      });
    }
    return run;
  }

  /**
   * Serialize every session mutation. The renewal timer, the queued-poll timer, and
   * acquire-time refreshes all POST /session; two concurrent POSTs make the upstream
   * rotate the instance id and one caller gets superseded mid-turn (observed as
   * waiting_room_required / session_superseded during long chats).
   */
  private async lockedSessionOp<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.sessionLock;
    let release!: () => void;
    this.sessionLock = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      return await op();
    } finally {
      release();
    }
  }

  async ensureSession(model?: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      // Rejoin (end + re-POST) when the requested model differs from the admitted one —
      // the upstream pins a session to its model; a mismatch or a model-less session
      // (created by startup maintenance) both yield free_mode_cli_required on chat.
      if (model && this.session && this.session.status !== "disabled" && this.sessionModel !== model) {
        try {
          await this.client.endSession(this.token, signal);
        } catch { /* best effort — the POST re-admission below decides state */ }
        this.session = null;
        this.sessionModel = undefined;
      }
      if (this.readySession()) return;
      const queued = this.queuedState();
      if (queued) throw new WaitingRoomError({ accountName: this.name, ...queued });
      await this.lockedSessionOp(async () => {
        // Re-check under the lock: a concurrent refresh may have already re-admitted.
        if (this.readySession()) return;
        await this.refreshSession(model, signal);
      });
    }
  }

  /** Persistence-only escape hatch (config save); never log or render the result. */
  revealToken(): string {
    return this.token;
  }

  /**
   * Acting-user id (x-freebuff-acting-user-id) from GET /api/v1/me — fetched lazily, cached.
   * Empty string means "known unavailable": non-fatal, calls proceed without the header.
   */
  private async ensureUserId(signal?: AbortSignal): Promise<void> {
    if (this.userId !== undefined) return;
    try {
      this.userId = await this.client.getUserId(this.token, signal);
    } catch {
      this.userId = "";
    }
  }

  /** Bound chat-completions call: keeps the auth token encapsulated inside the account. */
  async chat(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ response: Response } | { errorBody: string; status: number }> {
    await this.ensureUserId(signal);
    return this.client.chatCompletions(this.token, body, signal, this.userId || undefined);
  }

  setNotifier(notify: (notification: PoolNotification) => void): void {
    this.notify = notify;
  }

  private emitNotification(
    kind: NotificationKind,
    level: PoolNotification["level"],
    message: string,
    modelId?: string,
  ): void {
    this.notify({
      id: notificationId(),
      atMs: Date.now(),
      kind,
      level,
      account: this.name,
      ...(modelId !== undefined ? { modelId } : {}),
      message,
    });
  }

  /**
   * Instant free-session renewal: upstream owns the expiry (server-sided), so we arm a timer
   * that fires a few seconds BEFORE it and refreshes proactively. Errors retry on a short
   * backoff; the timer re-arms forever until shutdown. Premium/limited sessions are NOT
   * auto-renewed — admission is metered server-side, so those surface as notifications instead.
   */
  private scheduleRenewal(expiresAtMs: number): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    const delay = expiresAtMs > 0
      ? Math.max(expiresAtMs - RENEW_EARLY_MS - Date.now(), 1_000)
      : 60_000; // unknown expiry: refresh on a slow heartbeat
    this.renewalTimer = setTimeout(() => this.renewalTick(expiresAtMs), delay);
    this.renewalTimer.unref?.();
  }

  private renewalTick(previousExpiryMs: number): void {
    this.renewalTimer = null;
    const current = this.session;
    if (current?.status !== "active") return; // state changed elsewhere; the next acquire handles it
    // Another refresh already moved the expiry: re-arm instead of double-admitting.
    if (current.expiresAtMs > 0 && Date.now() < current.expiresAtMs - RENEW_EARLY_MS) {
      this.scheduleRenewal(current.expiresAtMs);
      return;
    }
    // Mid-turn: renewing now would rotate the seat under the in-flight request
    // (codebuff_metadata.freebuff_instance_id must match the live seat). Defer until done.
    if ([...this.runs.values()].some(run => run.inflight > 0)) {
      this.renewalTimer = setTimeout(() => this.renewalTick(current.expiresAtMs), 15_000);
      this.renewalTimer.unref?.();
      return;
    }
    void this.lockedSessionOp(() => this.refreshSession())
      .then(() => {
        this.emitNotification("session_renewed", "info", `free session renewed${previousExpiryMs > 0 ? " before expiry" : ""}`);
      })
      .catch(error => {
        this.lastError = errorText(error);
        this.emitNotification("account_error", "warn", `session renewal failed, retrying: ${errorText(error)}`);
        // Retry shortly; refreshSession failure cleared the session, so the next acquire
        // would also rebuild it — the timer just gets there first.
        this.renewalTimer = setTimeout(() => this.renewalTick(0), 5_000);
        this.renewalTimer.unref?.();
      });
  }

  /** Waiting-room poll timer: re-poll at the upstream-suggested interval, re-arm while queued. */
  private scheduleQueuedPoll(pollAtMs: number): void {
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.queuedTimer = setTimeout(() => {
      this.queuedTimer = null;
      if (this.session?.status !== "queued") return;
      void this.lockedSessionOp(() => this.refreshSession()).catch(error => {
        this.lastError = errorText(error);
        this.emitNotification("account_error", "warn", `waiting-room poll failed: ${errorText(error)}`);
        this.scheduleQueuedPoll(Date.now() + 5_000);
      });
    }, Math.max(pollAtMs - Date.now(), 1_000));
    this.queuedTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
    if (this.queuedTimer) {
      clearTimeout(this.queuedTimer);
      this.queuedTimer = null;
    }
  }

  invalidateSession(reason: string): void {
    this.session = null;
    this.sessionModel = undefined;
    if (reason) this.lastError = reason;
  }

  markCooldown(durationMs: number, reason: string): void {
    if (durationMs <= 0) return;
    this.cooldownUntilMs = Date.now() + durationMs;
    if (reason) {
      this.lastError = reason;
      this.emitNotification("cooldown", "warn", `account cooling down for ${Math.round(durationMs / 60_000)} min: ${reason}`);
    }
  }

  setLastError(reason: string): void {
    this.lastError = reason;
  }

  async release(run: ManagedRun): Promise<void> {
    if (run.inflight > 0) run.inflight -= 1;
    await this.finishIfReady(run).catch(error => {
      console.warn(`[${this.name}] finish released run ${run.id} failed: ${errorText(error)}`);
    });
  }

  async invalidate(run: ManagedRun, reason: string): Promise<void> {
    if (this.runs.get(run.agentId) === run) this.runs.delete(run.agentId);
    this.draining = this.draining.filter(candidate => candidate !== run);
    if (reason) this.lastError = reason;
  }

  async shutdown(): Promise<void> {
    this.clearTimers();
    const allRuns = [...this.runs.values(), ...this.draining];
    this.runs.clear();
    this.draining = [];
    const errors: string[] = [];
    for (const run of allRuns) {
      try {
        await this.client.finishRun(this.token, run.id, run.requestCount, undefined, this.userId || undefined);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    try {
      await this.client.endSession(this.token);
    } catch (error) {
      errors.push(errorText(error));
    }
    if (errors.length > 0) console.warn(`[${this.name}] shutdown errors: ${errors.join("; ")}`);
  }

  /** Maintain runs + session; called periodically. */
  async maintain(): Promise<void> {
    try {
      await this.ensureSession();
    } catch (error) {
      if (!(error instanceof WaitingRoomError)) {
        console.warn(`[${this.name}] refresh free session failed: ${errorText(error)}`);
      }
    }
    // (model-less maintenance refresh keeps the existing session pinned to its model)
    const expired = [...this.runs.values()].filter(run => Date.now() - run.startedAtMs >= this.rotationIntervalMs);
    for (const run of expired) {
      try {
        await this.rotateAgent(run.agentId);
      } catch (error) {
        console.warn(`[${this.name}] rotate agent ${run.agentId} failed: ${errorText(error)}`);
      }
    }
    for (const run of [...this.draining]) {
      await this.finishIfReady(run).catch(() => {});
    }
  }

  private readySession(): boolean {
    const session = this.session;
    if (!session) return false;
    if (session.status === "disabled") return true;
    if (session.status === "active") {
      if (!session.instanceId) return false;
      // Tight acquire-time boundary: only refresh when expiry is seconds away. The
      // proactive RENEW_EARLY_MS renewal is the timer's job (deferred mid-turn), so an
      // acquire must never loop re-admitting sessions that are still perfectly valid.
      return session.expiresAtMs === 0 || Date.now() < session.expiresAtMs - 5_000;
    }
    return false;
  }

  private queuedState(): QueuedInfo | null {
    const session = this.session;
    if (!session || session.status !== "queued") return null;
    if (session.pollAtMs && Date.now() < session.pollAtMs) {
      return {
        position: session.position,
        queueDepth: session.queueDepth,
        retryAfterMs: session.pollAtMs - Date.now(),
      };
    }
    return null;
  }

  private async refreshSession(model?: string, signal?: AbortSignal): Promise<void> {
    const current = this.session;
    let state: SessionState;
    const requested = model ?? this.sessionModel;
    try {
      if (current?.status === "queued" && current.instanceId) {
        state = await this.client.getSession(this.token, current.instanceId, signal);
      } else {
        state = await this.client.createOrRefreshSession(this.token, { model: requested, signal });
        // Admission is for the model we asked for, whether or not the upstream echoes it
        // back in the response body (queued responses don't). Recording it here prevents a
        // model-less echo from wiping the pin and triggering endless rejoins.
        if (requested) this.sessionModel = requested;
      }
    } catch (error) {
      this.session = null;
      this.sessionModel = undefined;
      this.lastError = errorText(error);
      // A token the upstream rejects on SESSION ADMISSION is dead (rotated server-side).
      // Cooldown so acquire() skips it and maintenance stops hammering /session every
      // cycle — same backoff philosophy as the CLI's 429 handling.
      if (error instanceof UpstreamError && error.status === 401) {
        this.markCooldown(30 * 60_000, "upstream auth rejected token");
      }
      throw error;
    }
    await this.applySessionState(state, signal);
  }

  private async applySessionState(state: SessionState, signal?: AbortSignal): Promise<void> {
    for (;;) {
      switch (state.status) {
        case "disabled":
          this.session = { status: "disabled", instanceId: "", expiresAtMs: 0, position: 0, queueDepth: 0, pollAtMs: 0 };
          return;
        case "active": {
          if (!state.instanceId) throw new Error("free session active response missing instanceId");
          const expiresAtMs = parseOptionalTimeMs(state.expiresAt);
          this.session = {
            status: "active",
            instanceId: state.instanceId,
            expiresAtMs,
            position: 0,
            queueDepth: 0,
            pollAtMs: 0,
          };
          this.sessionModel = state.model ?? this.sessionModel;
          // Server-sided expiry → renew instantly, just before it lapses.
          this.scheduleRenewal(expiresAtMs);
          return;
        }
        case "queued": {
          if (!state.instanceId) throw new Error("free session queued response missing instanceId");
          const delayMs = queuedPollDelayMs(state);
          const pollAtMs = Date.now() + delayMs;
          this.session = {
            status: "queued",
            instanceId: state.instanceId,
            expiresAtMs: 0,
            position: Math.max(state.position, 1),
            queueDepth: Math.max(state.queueDepth, state.position, 1),
            pollAtMs,
          };
          this.sessionModel = state.model ?? this.sessionModel;
          this.scheduleQueuedPoll(pollAtMs);
          this.emitNotification(
            "session_queued",
            "info",
            `waiting room: position ${Math.max(state.position, 1)}${state.queueDepth ? `/${state.queueDepth}` : ""}`
              + `${state.estimatedWaitMs ? `, ~${Math.round(state.estimatedWaitMs / 60_000)} min remaining` : ""}`,
          );
          return;
        }
        case "none":
        case "ended":
        case "superseded": {
          state = await this.client.createOrRefreshSession(this.token, { model: this.sessionModel, signal });
          continue;
        }
        default:
          throw new Error(`unexpected free session status ${JSON.stringify(state.status)}`);
      }
    }
  }

  private async finishIfReady(run: ManagedRun): Promise<void> {
    if (run.inflight > 0 || run.finishing) return;
    if (this.runs.get(run.agentId) === run) return;
    run.finishing = true;
    try {
      await this.client.finishRun(this.token, run.id, run.requestCount);
      this.draining = this.draining.filter(candidate => candidate !== run);
    } catch (error) {
      run.finishing = false;
      throw error;
    }
  }
}

export class AccountLease {
  constructor(
    readonly account: FreebuffAccount,
    private readonly run: ManagedRun,
  ) {}

  get runId(): string {
    return this.run.id;
  }

  /** Active free-session instance id, for codebuff_metadata.freebuff_instance_id. */
  get sessionInstanceId(): string | undefined {
    return this.account.getSessionInstanceId() || undefined;
  }

  async release(): Promise<void> {
    await this.account.release(this.run);
  }

  async invalidate(reason: string): Promise<void> {
    await this.account.invalidate(this.run, reason);
  }
}

export class AccountPool {
  private accounts: FreebuffAccount[];
  private nextIndex = 0;
  private readonly notifications: PoolNotification[] = [];
  private readonly subscribers = new Set<(notification: PoolNotification) => void>();

  constructor(accounts: FreebuffAccount[]) {
    this.accounts = accounts;
    const forward = (notification: PoolNotification) => this.pushNotification(notification);
    for (const account of accounts) account.setNotifier(forward);
    this.notifierForNewAccounts = forward;
  }

  private notifierForNewAccounts: (notification: PoolNotification) => void;

  get size(): number {
    return this.accounts.length;
  }

  /**
   * Round-robin across healthy accounts. Waiting-room states are skipped when other accounts
   * can serve; all-queued surfaces the best (lowest position) queue to the caller.
   */
  async acquire(agentId: string, model?: string, signal?: AbortSignal): Promise<{ lease: AccountLease; account: FreebuffAccount }> {
    if (this.accounts.length === 0) throw new Error("no auth tokens configured");
    const startIndex = this.nextIndex;
    this.nextIndex = (this.nextIndex + 1) % this.accounts.length;
    const waiting: WaitingRoomError[] = [];
    const errors: string[] = [];
    for (let offset = 0; offset < this.accounts.length; offset++) {
      const account = this.accounts[(startIndex + offset) % this.accounts.length]!;
      try {
        const lease = await account.acquire(agentId, model, signal);
        return { lease, account };
      } catch (error) {
        if (error instanceof WaitingRoomError) {
          waiting.push(error);
          continue;
        }
        errors.push(`${account.name}: ${errorText(error)}`);
      }
    }
    if (waiting.length === this.accounts.length && waiting.length > 0) {
      const best = waiting.reduce((a, b) => (b.position > 0 && (a.position <= 0 || b.position < a.position) ? b : a));
      throw best;
    }
    throw new Error(`unable to acquire run from any account (${errors.join("; ")})`);
  }

  snapshots(): AccountSnapshot[] {
    return this.accounts.map(account => account.snapshot());
  }

  listAccounts(): FreebuffAccount[] {
    return [...this.accounts];
  }

  /** Append a live account; takes effect on the next acquire. */
  addAccount(account: FreebuffAccount): void {
    account.setNotifier(this.notifierForNewAccounts);
    this.accounts.push(account);
  }

  // ── Notification hub ────────────────────────────────────────────────

  private pushNotification(notification: PoolNotification): void {
    this.notifications.push(notification);
    if (this.notifications.length > MAX_NOTIFICATIONS) this.notifications.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(notification);
      } catch { /* subscriber errors never break the pool */ }
    }
  }

  /** Account-level notices (renewals, queue, cooldown) flow through here automatically. */
  subscribe(listener: (notification: PoolNotification) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  recentNotifications(sinceMs = 0): PoolNotification[] {
    return this.notifications.filter(notification => notification.atMs >= sinceMs);
  }

  /** Tier-aware model-use notice: premium/limited models surface a quota warning. */
  notifyModelUse(account: string, modelId: string, tier: ModelTier): void {
    if (tier === "premium") {
      this.pushNotification({
        id: notificationId(),
        atMs: Date.now(),
        level: "warn",
        kind: "premium_model",
        account,
        modelId,
        message: `premium model ${modelId} uses the daily premium pool (limit ${PREMIUM_SESSION_LIMIT}/day per account) — sessions are metered server-side and NOT auto-renewed`,
      });
    } else if (tier === "limited") {
      this.pushNotification({
        id: notificationId(),
        atMs: Date.now(),
        level: "warn",
        kind: "limited_model",
        account,
        modelId,
        message: `limited-offer model ${modelId} draws from a shared global pool — availability is not guaranteed`,
      });
    }
  }

  /** Remove a live account by name; its runs finish in the background. */
  async removeAccount(name: string): Promise<boolean> {
    const index = this.accounts.findIndex(account => account.name === name);
    if (index === -1) return false;
    const [removed] = this.accounts.splice(index, 1);
    if (removed) {
      await removed.shutdown().catch(error => {
        console.warn(`[${name}] shutdown after removal failed: ${errorText(error)}`);
      });
    }
    if (this.nextIndex >= this.accounts.length) this.nextIndex = 0;
    return true;
  }

  findAccount(name: string): FreebuffAccount | undefined {
    return this.accounts.find(account => account.name === name);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.accounts.map(account => account.shutdown()));
  }

  async maintainAll(): Promise<void> {
    await Promise.all(this.accounts.map(account => account.maintain()));
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
