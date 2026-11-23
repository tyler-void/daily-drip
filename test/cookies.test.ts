import { describe, expect, test } from "bun:test";
import { hashCookieFile, mergeSetCookies, parseCookieFile, serializeJar } from "../src/cookies.ts";

describe("parseCookieFile", () => {
  test("reads a whole cookie header", () => {
    expect(parseCookieFile("ssid=abc; clid=ec1; tdid=xyz")).toEqual({ ssid: "abc", clid: "ec1", tdid: "xyz" });
  });

  test("treats a bare value as ssid", () => {
    expect(parseCookieFile("eyJhbGciOi.payload.sig\n")).toEqual({ ssid: "eyJhbGciOi.payload.sig" });
  });

  test("tolerates a BOM, a leading 'cookie:' and trailing newlines", () => {
    expect(parseCookieFile("﻿cookie: ssid=abc; clid=ec1\r\n")).toEqual({ ssid: "abc", clid: "ec1" });
  });

  test("keeps '=' inside values", () => {
    expect(parseCookieFile("a=b==; c=d")).toEqual({ a: "b==", c: "d" });
  });

  test("an empty file gives an empty jar", () => {
    expect(parseCookieFile("  \n")).toEqual({});
  });
});

describe("mergeSetCookies", () => {
  const now = Date.parse("2026-11-23T00:00:00Z");

  test("rotated cookies replace old values and new ones are added", () => {
    const jar = { ssid: "old", clid: "c1" };
    const next = mergeSetCookies(jar, ["ssid=new; Path=/; Secure; HttpOnly", "ccid=x; Domain=auth.riotgames.com"], now);
    expect(next).toEqual({ ssid: "new", clid: "c1", ccid: "x" });
  });

  test("does not change the jar it was given", () => {
    const jar = { ssid: "old" };
    mergeSetCookies(jar, ["ssid=new"], now);
    expect(jar).toEqual({ ssid: "old" });
  });

  test("removes cookies that are empty, Max-Age=0 or already expired", () => {
    const jar = { a: "1", b: "2", c: "3", d: "4" };
    const next = mergeSetCookies(
      jar,
      ["a=; Path=/", "b=x; Max-Age=0", "c=x; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "d=5; Expires=Wed, 21 Oct 2037 07:28:00 GMT"],
      now,
    );
    expect(next).toEqual({ d: "5" });
  });
});

test("serializeJar writes a cookie header", () => {
  expect(serializeJar({ ssid: "a", clid: "b" })).toBe("ssid=a; clid=b");
});

test("hashCookieFile ignores surrounding whitespace and a BOM", () => {
  expect(hashCookieFile("﻿ssid=a\r\n")).toBe(hashCookieFile("ssid=a"));
  expect(hashCookieFile("ssid=a")).not.toBe(hashCookieFile("ssid=b"));
});
