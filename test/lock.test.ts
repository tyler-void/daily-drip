import { expect, test } from "bun:test";
import { createLock } from "../src/lock.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("runs never overlap: the second starts after the first ends", async () => {
  const withLock = createLock();
  const events: string[] = [];
  const run = (name: string, ms: number) =>
    withLock(async () => {
      events.push(`${name} start`);
      await sleep(ms);
      events.push(`${name} end`);
      return name;
    });
  const results = await Promise.all([run("scheduled", 20), run("/shop", 1)]);
  expect(results).toEqual(["scheduled", "/shop"]);
  expect(events).toEqual(["scheduled start", "scheduled end", "/shop start", "/shop end"]);
});

test("a failed run does not block the next one", async () => {
  const withLock = createLock();
  const failed = withLock(async () => {
    throw new Error("boom");
  });
  await expect(failed).rejects.toThrow("boom");
  expect(await withLock(async () => "next")).toBe("next");
});
