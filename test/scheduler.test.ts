import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCookieFile } from "../src/cookies.ts";
import { CloudflareBlockedError, CookieDeadError, RateLimitedError, UnexpectedResponseError } from "../src/riot/auth.ts";
import { BadClaimsError, MaintenanceError } from "../src/riot/store.ts";
import { AFTER_RESET_MS, createScheduler, DEFAULT_RETRY_MS, failurePolicy } from "../src/scheduler.ts";
import type { ShopSnapshot } from "../src/shop.ts";
import { emptyState, type State } from "../src/state.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-23T03:00:00Z");
const RESET = Date.parse("2026-11-24T00:00:00Z");

const snapshot = (expiresAt = RESET): ShopSnapshot => ({ fetchedAt: "", expiresAt: new Date(expiresAt).toISOString(), offers: [], hash: "h" });

let dir: string;
let cookieFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-scheduler-"));
  cookieFile = join(dir, "riot-cookie");
  await writeFile(cookieFile, "ssid=good");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A scheduler with a fake clock; `results` are what successive runs return or throw. */
function setup(results: Array<ShopSnapshot | Error>, init: (state: State) => void = () => {}) {
  const clock = { t: T0 };
  const state = emptyState();
  state.cookie = { jar: { ssid: "good" }, sourceHash: hashCookieFile("ssid=good") };
  state.lastSuccessAt = new Date(T0).toISOString();
  init(state);
  const alerts: string[] = [];
  let runs = 0;
  let heartbeats = 0;
  let alertFails = 0;
  const scheduler = createScheduler({
    state,
    save: async () => {},
    run: async () => {
      runs++;
      const next = results.shift() ?? snapshot();
      if (next instanceof Error) throw next;
      state.lastSuccessAt = new Date(clock.t).toISOString();
      return next;
    },
    notifier: {
      sendAlert: async (text) => {
        if (alertFails > 0) {
          alertFails--;
          throw new Error("Discord down");
        }
        alerts.push(text);
      },
    },
    cookieFile,
    heartbeat: async () => {
      heartbeats++;
    },
    now: () => clock.t,
  });
  return {
    scheduler,
    state,
    alerts,
    clock,
    runs: () => runs,
    heartbeats: () => heartbeats,
    failNextAlerts: (n: number) => {
      alertFails = n;
    },
    at: async (t: number) => {
      clock.t = t;
      await scheduler.tick();
    },
  };
}

describe("failurePolicy follows the error table", () => {
  test.each([
    [new CloudflareBlockedError("403"), HOUR, "blockedNotified"],
    [new MaintenanceError("downtime"), DEFAULT_RETRY_MS, undefined],
    [new BadClaimsError("BAD_CLAIMS"), DEFAULT_RETRY_MS, "badClaimsNotified"],
    [new UnexpectedResponseError("E6 500"), DEFAULT_RETRY_MS, undefined],
    [new CookieDeadError("login"), DEFAULT_RETRY_MS, "cookieDeadNotified"],
    [new Error("anything else"), DEFAULT_RETRY_MS, undefined],
  ] as const)("%p", (err, retry, flag) => {
    const policy = failurePolicy(err, "config/riot-cookie");
    expect(policy.retryInMs).toBe(retry);
    expect(policy.alert?.flag).toBe(flag);
  });

  test("a rate limit waits Retry-After, but at least a minute", () => {
    expect(failurePolicy(new RateLimitedError("E6", 600), "x").retryInMs).toBe(600_000);
    expect(failurePolicy(new RateLimitedError("E6", 0), "x").retryInMs).toBe(MINUTE);
  });
});

describe("scheduler", () => {
  test("runs at once on start, then 90 s after the reset, and pings the heartbeat", async () => {
    const s = setup([snapshot(RESET), snapshot(RESET + 24 * HOUR)]);
    await s.at(T0);
    expect(s.runs()).toBe(1);
    expect(s.scheduler.nextRunAt()).toBe(RESET + AFTER_RESET_MS);
    expect(s.heartbeats()).toBe(1);

    await s.at(RESET + AFTER_RESET_MS - 1);
    expect(s.runs()).toBe(1);
    await s.at(RESET + AFTER_RESET_MS);
    expect(s.runs()).toBe(2);
    expect(s.scheduler.nextRunAt()).toBe(RESET + 24 * HOUR + AFTER_RESET_MS);
  });

  test("a tick long after the planned time (host asleep) still runs once", async () => {
    const s = setup([snapshot(RESET)]);
    await s.at(T0);
    await s.at(RESET + 5 * HOUR);
    expect(s.runs()).toBe(2);
  });

  test("an already-expired shop is not re-fetched in a tight loop", async () => {
    const s = setup([snapshot(T0 - HOUR)]);
    await s.at(T0);
    expect(s.scheduler.nextRunAt()).toBe(T0 + MINUTE);
  });

  test("a failed run retries after 30 min, not at the next reset", async () => {
    const s = setup([new UnexpectedResponseError("E6 500"), snapshot()]);
    await s.at(T0);
    expect(s.scheduler.nextRunAt()).toBe(T0 + DEFAULT_RETRY_MS);
    await s.at(T0 + DEFAULT_RETRY_MS - MINUTE);
    expect(s.runs()).toBe(1);
    await s.at(T0 + DEFAULT_RETRY_MS);
    expect(s.runs()).toBe(2);
    expect(s.alerts).toHaveLength(0);
  });

  test("a Cloudflare block alerts once and retries hourly", async () => {
    const s = setup([new CloudflareBlockedError("403"), new CloudflareBlockedError("403"), snapshot()]);
    await s.at(T0);
    await s.at(T0 + HOUR);
    expect(s.runs()).toBe(2);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toContain("Riot blocked the login");
    expect(s.state.flags.blockedNotified).toBe(true);
  });

  test("a dead cookie alerts once, then waits for the cookie file instead of retrying", async () => {
    const s = setup([new CookieDeadError("login redirect")]);
    await s.at(T0);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toContain("Riot cookie expired");
    expect(s.state.flags.cookieDeadNotified).toBe(true);

    // Hours pass, the retry time passes: no run while the file is unchanged.
    await s.at(T0 + 3 * HOUR);
    expect(s.runs()).toBe(1);

    // A new cookie file: the next tick runs.
    await writeFile(cookieFile, "ssid=fresh");
    await s.at(T0 + 3 * HOUR + MINUTE);
    expect(s.runs()).toBe(2);
  });

  test("a new cookie file that does not help is tried once, not every minute", async () => {
    const s = setup([new CookieDeadError("login"), new CookieDeadError("empty file")]);
    await s.at(T0);
    await writeFile(cookieFile, "ssid=also-bad");
    await s.at(T0 + MINUTE);
    await s.at(T0 + 2 * MINUTE);
    await s.at(T0 + 3 * MINUTE);
    expect(s.runs()).toBe(2);
  });

  test("an alert that cannot be sent is not marked as sent, and goes out on the next failure", async () => {
    const s = setup([new CloudflareBlockedError("403"), new CloudflareBlockedError("403")]);
    s.failNextAlerts(1);
    await s.at(T0);
    expect(s.state.flags.blockedNotified).toBe(false);
    await s.at(T0 + HOUR);
    expect(s.alerts).toHaveLength(1);
    expect(s.state.flags.blockedNotified).toBe(true);
  });

  test("dead-man switch: one warning after 26 h without success", async () => {
    const s = setup(Array.from({ length: 60 }, () => new UnexpectedResponseError("E6 500")));
    await s.at(T0);
    for (let h = 1; h <= 28; h++) await s.at(T0 + h * HOUR);
    const deadMan = s.alerts.filter((a) => a.includes("No shop for"));
    expect(deadMan).toHaveLength(1);
    expect(deadMan[0]).toContain("No shop for 26 hours");
    expect(deadMan[0]).toContain("E6 500");
  });

  test("dead-man switch stays quiet while the cookie-dead alert explains the silence", async () => {
    const s = setup([new CookieDeadError("login")]);
    await s.at(T0);
    await s.at(T0 + 30 * HOUR);
    expect(s.alerts.filter((a) => a.includes("No shop for"))).toHaveLength(0);
  });

  test("ticks do not overlap a run that is still going", async () => {
    let release: () => void = () => {};
    const state = emptyState();
    let runs = 0;
    const scheduler = createScheduler({
      state,
      save: async () => {},
      run: () => {
        runs++;
        return new Promise<ShopSnapshot>((resolve) => {
          release = () => resolve(snapshot());
        });
      },
      notifier: { sendAlert: async () => {} },
      cookieFile,
      now: () => T0,
    });
    const first = scheduler.tick();
    await scheduler.tick();
    expect(runs).toBe(1);
    release();
    await first;
  });

  test("alerts are redacted before they leave", async () => {
    const s = setup([new CloudflareBlockedError("E1 refused: token eyJhbGciOiJIUzI1NiJ9.e30.sig")]);
    await s.at(T0);
    expect(s.alerts[0]).not.toContain("eyJ");
  });
});
