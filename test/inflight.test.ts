import { expect, test } from "bun:test";
import { drain, inFlight, track } from "../src/inflight.ts";

test("drain waits for tracked work, including work started while draining", async () => {
  const order: string[] = [];
  void track(async () => {
    await Bun.sleep(30);
    order.push("first");
    void track(async () => {
      await Bun.sleep(30);
      order.push("second");
    });
  });
  expect(inFlight()).toBe(1);
  expect(await drain(1000)).toBe(true);
  expect(order).toEqual(["first", "second"]);
  expect(inFlight()).toBe(0);
});

test("drain gives up after the timeout; failed work still counts as done", async () => {
  void track(() => Bun.sleep(300));
  await track(async () => {
    throw new Error("x");
  }).catch(() => {});
  expect(inFlight()).toBe(1);
  expect(await drain(20)).toBe(false);
  expect(await drain(1000)).toBe(true);
});
