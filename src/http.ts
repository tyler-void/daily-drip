// HTTP client for Riot and valorant-api.com (spec: Endpoints & headers).
// This is the only file allowed to use runtime-specific APIs, so moving to Node
// (the TLS fallback in the spec) touches this file alone.

import { log } from "./log.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class NetworkError extends Error {
  name = "NetworkError";
  readonly host: string;

  constructor(host: string, cause: unknown) {
    // The message names the host and the cause; it never includes headers.
    super(`network error on ${host}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.host = host;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The real cookie header. Requests without one send SkinPeek's dummy cookie. */
  cookie?: string;
  timeoutMs?: number;
}

export interface Http {
  request(url: string, options?: RequestOptions): Promise<Response>;
}

// SkinPeek sends both on every request; its comment says they help against Cloudflare error 1020.
const BASE_HEADERS = { "Accept-Language": "en-US,en;q=0.5" };
const DUMMY_COOKIE = "dummy=cookie";

export function createHttp(fetchFn: FetchFn = fetch): Http {
  return {
    async request(url, options = {}) {
      const method = options.method ?? "GET";
      const { host, pathname } = new URL(url);
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchFn(url, {
          method,
          headers: { ...BASE_HEADERS, cookie: options.cookie ?? DUMMY_COOKIE, ...options.headers },
          body: options.body,
          // Never follow redirects: E1's answer is the redirect itself, and a followed
          // redirect could carry the Authorization header to another host.
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch (err) {
        throw new NetworkError(host, err);
      }
      log.debug("http", { method, host, path: pathname, status: res.status, ms: Date.now() - started });
      return res;
    },
  };
}
