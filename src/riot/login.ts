// Member onboarding with a Riot sign-in link (spec: Accounts). The Riot Client OAuth
// authorization-code flow: a link to Riot's own sign-in page, the one-time code the member pastes
// back, and the refresh token the bot keeps. No password or cookie is handled here. The request
// shapes are the ones scripts/code-spike.ts checked against the real endpoints.

import { randomUUID } from "node:crypto";
import type { Http } from "../http.ts";
import { addSecret } from "../log.ts";
import { parseRetryAfter, RateLimitedError } from "./auth.ts";

export const AUTHORIZE_URL = "https://auth.riotgames.com/authorize";
export const TOKEN_URL = "https://auth.riotgames.com/token";
export const CLIENT_ID = "riot-client";
// Riot only redirects the riot-client sign-in to this exact address (checked 2026-11-24); a custom
// one needs a registered client, which Riot grants only with an approved production key.
export const REDIRECT_URI = "http://localhost/redirect";
export const SCOPE = "openid link ban lol_region account offline_access";
export const LOGIN_USER_AGENT = "RiotGamesApi/24.10.1.4471 rso-auth (Windows;10;;Professional, x64) riot_client/0";

/** The sign-in or refresh is no longer valid (Riot's `invalid_grant`): the member must link again. */
export class LoginDeadError extends Error {
  name = "LoginDeadError";
}

/** The token endpoint answered in some other unexpected way. */
export class LoginFailedError extends Error {
  name = "LoginFailedError";
}

export interface Tokens {
  accessToken: string;
  idToken: string;
  /** Kept and reused; Riot may rotate it on each refresh, so always store the newest. */
  refreshToken: string;
  expiresInSeconds: number;
}

/** The link a member opens to sign in on Riot's own page. The nonce is per-link. */
export function buildSignInUrl(nonce: string = randomUUID()): string {
  const params = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPE, nonce });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * The one-time code from what a member pastes. Lenient on purpose, because a code only works at
 * Riot's token endpoint for this one sign-in, so accepting it in any shape risks nothing:
 *
 * - the whole address, http or https (a browser in HTTPS-only mode rewrites http://localhost);
 * - the address without "http://", which browsers drop when part of the bar is selected by hand;
 * - a piece of it containing "code=…";
 * - the code on its own.
 *
 * Refused: text with no code in it, and anything that looks like a JWT (a cookie or token pasted by
 * mistake), so it isn't sent to Riot as a code.
 */
export function extractCode(pasted: string): string | null {
  const text = pasted.trim();
  const plausible = (code: string | null | undefined): string | null =>
    code && code.length >= 8 && !code.startsWith("eyJ") && /^[A-Za-z0-9._~+/=-]+$/.test(code) ? code : null;

  // An address, with or without its scheme.
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    const fromUrl = plausible(url.searchParams.get("code"));
    if (fromUrl) return fromUrl;
  } catch {
    // not an address; try the other shapes
  }
  // A piece of the address: "...&code=...".
  const match = text.match(/(?:^|[?&#\s])code=([^&#\s]+)/);
  if (match?.[1]) return plausible(safeDecode(match[1]));
  // The code on its own; copied out of the address bar it may still be URL-encoded.
  if (/^\S{20,}$/.test(text)) return plausible(safeDecode(text));
  return null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function postToken(http: Http, params: Record<string, string>, what: string, fallbackRefresh?: string): Promise<Tokens> {
  const res = await http.request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": LOGIN_USER_AGENT },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status === 429) throw new RateLimitedError("auth.riotgames.com/token", parseRetryAfter(res.headers.get("retry-after")));

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // handled by the access-token check below
  }
  for (const key of ["access_token", "id_token", "refresh_token"]) {
    if (typeof body[key] === "string") addSecret(body[key] as string);
  }

  if (!res.ok || typeof body.access_token !== "string") {
    // Riot's OAuth errors are short codes such as invalid_grant; they carry no secret.
    const code = typeof body.error === "string" ? body.error : undefined;
    if (code === "invalid_grant") throw new LoginDeadError(`${what}: the sign-in is no longer valid`);
    throw new LoginFailedError(`${what} answered ${res.status}${code ? ` (${code})` : ""}`);
  }

  // On a refresh, Riot may omit refresh_token to mean "keep using the one you have".
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : (fallbackRefresh ?? "");
  if (!refreshToken) throw new LoginFailedError(`${what}: no refresh token`);
  return {
    accessToken: body.access_token,
    idToken: typeof body.id_token === "string" ? body.id_token : "",
    refreshToken,
    expiresInSeconds: Number(body.expires_in) || 3600,
  };
}

/** Trade the pasted one-time code for the first set of tokens, including the refresh token. */
export function exchangeCode(http: Http, code: string): Promise<Tokens> {
  return postToken(http, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID }, "the code exchange");
}

/** Trade a stored refresh token for fresh tokens before a run. Returns the newest refresh token to store. */
export function refreshTokens(http: Http, refreshToken: string): Promise<Tokens> {
  return postToken(http, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }, "the refresh", refreshToken);
}
