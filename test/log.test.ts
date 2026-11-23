import { expect, test } from "bun:test";
import { addSecret, redact, redactHeaders } from "../src/log.ts";

test("redacts ssid values, bearer tokens and JWTs", () => {
  const line = 'cookie "ssid=abc.def-ghi; clid=ec1" Authorization: Bearer xyz123 token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
  const out = redact(line);
  expect(out).not.toContain("abc.def-ghi");
  expect(out).not.toContain("xyz123");
  expect(out).not.toContain("eyJ");
  expect(out).toContain("ssid=[redacted]");
  expect(out).toContain("Bearer [redacted]");
  expect(out).toContain("clid=ec1"); // short, unregistered values stay readable
});

test("redacts registered secrets such as the bot token", () => {
  addSecret("MTA5ODc2NTQzMjE.discord.token-value");
  expect(redact("token is MTA5ODc2NTQzMjE.discord.token-value!")).toBe("token is [redacted]!");
});

test("ignores very short secrets so ordinary words survive", () => {
  addSecret("ap");
  expect(redact("shard ap")).toBe("shard ap");
});

test("redactHeaders hides sensitive headers by name, in any case", () => {
  const headers = new Headers({ Cookie: "ssid=a", Authorization: "Bearer b", "X-Riot-Entitlements-JWT": "c", Location: "d", "Content-Type": "json" });
  expect(redactHeaders(headers)).toEqual({
    cookie: "[redacted]",
    authorization: "[redacted]",
    "x-riot-entitlements-jwt": "[redacted]",
    location: "[redacted]",
    "content-type": "json",
  });
});
