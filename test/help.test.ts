import { expect, test } from "bun:test";
import { helpEmbed, type HelpInfo, nextReset } from "../src/help.ts";

const all: HelpInfo = { linking: true, recaps: true, shopChannelId: "100", recapChannelId: "200" };
const NOW = Date.UTC(2026, 10, 24, 18, 30);
const text = (e: ReturnType<typeof helpEmbed>) => [e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join("\n");

test("the next reset is the coming 00:00 UTC, as a Discord timestamp", () => {
  expect(nextReset(NOW)).toBe(`<t:${Date.UTC(2026, 10, 25) / 1000}:t>`);
});

test("everything switched on: every command, the channels, and the reset time", () => {
  const t = text(helpEmbed(all, { isOwner: false, shared: false, now: NOW }));
  for (const cmd of ["/link", "/unlink", "/shop", "/preview", "/wishlist add", "/wishlist list", "/recap on", "/recap join", "/recap show", "/recap trigger", "/recap list"]) expect(t).toContain(cmd);
  expect(t).toContain("<#100>");
  expect(t).toContain("<#200>");
  expect(t).toContain(nextReset(NOW));
  expect(t).not.toContain("/recap remove");
});

test("features that are off aren't listed", () => {
  const t = text(helpEmbed({ ...all, linking: false, recaps: false }, { isOwner: true, shared: false, now: NOW }));
  expect(t).not.toContain("/link");
  expect(t).not.toContain("/recap");
  expect(t).toContain("/shop");
});

test("owner-only commands show to the owner, privately; never in a shared post", () => {
  expect(text(helpEmbed(all, { isOwner: true, shared: false, now: NOW }))).toContain("/recap remove");
  const shared = helpEmbed(all, { isOwner: true, shared: true, now: NOW });
  expect(text(shared)).not.toContain("/recap remove");
  expect(shared.footer?.text).not.toContain("Only you");
});

test("every field fits Discord's 1,024-character limit", () => {
  for (const f of helpEmbed(all, { isOwner: true, shared: false, now: NOW }).fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
});
