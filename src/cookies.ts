// Riot cookie jar: parse the cookie file, merge Riot's rotated Set-Cookie lines, serialise.

import { createHash } from "node:crypto";

export type CookieJar = Record<string, string>;

/** Hash of the cookie file. A different hash means the owner put in a new cookie. */
export function hashCookieFile(raw: string): string {
  // trim() also strips a BOM. The spike hashes the same way, so its jar can be imported.
  return createHash("sha256").update(raw.trim()).digest("hex");
}

/**
 * Parse the cookie file: the whole `cookie` request header, or a bare `ssid` value.
 * Tolerates a BOM, a leading "cookie:" and trailing newlines.
 */
export function parseCookieFile(raw: string): CookieJar {
  let text = raw.replace(/^﻿/, "").trim().replace(/^cookie:\s*/i, "");
  if (!text) return {};
  if (!text.includes("=")) text = `ssid=${text}`;
  const jar: CookieJar = {};
  for (const part of text.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

/** Merge Set-Cookie lines into a copy of the jar. An empty or expired cookie is removed. */
export function mergeSetCookies(jar: CookieJar, setCookies: string[], now = Date.now()): CookieJar {
  const next: CookieJar = { ...jar };
  for (const line of setCookies) {
    const [pair = "", ...attributes] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!value || isExpired(attributes, now)) delete next[name];
    else next[name] = value;
  }
  return next;
}

function isExpired(attributes: string[], now: number): boolean {
  for (const attribute of attributes) {
    const i = attribute.indexOf("=");
    if (i < 0) continue;
    const key = attribute.slice(0, i).trim().toLowerCase();
    const value = attribute.slice(i + 1).trim();
    if (key === "max-age" && Number(value) <= 0) return true;
    if (key === "expires" && Date.parse(value) <= now) return true;
  }
  return false;
}

export function serializeJar(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
