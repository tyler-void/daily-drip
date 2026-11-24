import { expect, test } from "bun:test";
import { importKey, open, seal } from "../src/secretbox.ts";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

test("seal then open round-trips, with a fresh IV each time", async () => {
  const key = await importKey(KEY_A);
  const a = await seal(key, "refresh-token-value");
  const b = await seal(key, "refresh-token-value");
  expect(a).not.toBe(b);
  expect(a).not.toContain("refresh-token-value");
  expect(await open(key, a)).toBe("refresh-token-value");
  expect(await open(key, b)).toBe("refresh-token-value");
});

test("the wrong key can't open it", async () => {
  const sealed = await seal(await importKey(KEY_A), "secret");
  await expect(open(await importKey(KEY_B), sealed)).rejects.toThrow();
});

test("an altered value is rejected", async () => {
  const key = await importKey(KEY_A);
  const [iv, ct] = (await seal(key, "secret")).split(".");
  const bytes = Buffer.from(ct!, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  await expect(open(key, `${iv}.${bytes.toString("base64")}`)).rejects.toThrow();
  await expect(open(key, "no-dot-here")).rejects.toThrow("not a sealed value");
});

test("a key that isn't 32 bytes is refused, with how to make one", async () => {
  await expect(importKey(Buffer.alloc(16).toString("base64"))).rejects.toThrow("openssl rand -base64 32");
});
