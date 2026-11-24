import { expect, test } from "bun:test";
import type { Session } from "../src/riot/auth.ts";
import { createSessionCache, SESSION_TTL_MS } from "../src/sessions.ts";

const session = (n: number): Session => ({ accessToken: `AT${n}`, idToken: "IT", entitlementsToken: "ENT", puuid: "p", shard: "ap", riotName: null });

function setup() {
  let t = 0;
  let mints = 0;
  const cache = createSessionCache({ now: () => t });
  const mint = async () => session(++mints);
  return { cache, mint, mints: () => mints, advance: (ms: number) => (t += ms) };
}

test("a session is reused for 50 minutes, then minted again", async () => {
  const s = setup();
  expect((await s.cache.get("owner", s.mint)).accessToken).toBe("AT1");
  s.advance(SESSION_TTL_MS - 1);
  expect((await s.cache.get("owner", s.mint)).accessToken).toBe("AT1");
  s.advance(1);
  expect((await s.cache.get("owner", s.mint)).accessToken).toBe("AT2");
  expect(s.mints()).toBe(2);
});

test("people are cached separately; drop forces a new mint (after a 401 or BAD_CLAIMS)", async () => {
  const s = setup();
  await s.cache.get("owner", s.mint);
  await s.cache.get("member-1", s.mint);
  expect(s.cache.size()).toBe(2);
  s.cache.drop("owner");
  expect((await s.cache.get("owner", s.mint)).accessToken).toBe("AT3");
});

test("concurrent gets share one mint, so one sign-in, not two", async () => {
  const s = setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let mints = 0;
  const slowMint = async () => {
    mints++;
    await gate;
    return session(mints);
  };
  const a = s.cache.get("owner", slowMint);
  const b = s.cache.get("owner", slowMint);
  release();
  expect((await a).accessToken).toBe((await b).accessToken);
  expect(mints).toBe(1);
});

test("a failed mint isn't cached; the next get tries again", async () => {
  const s = setup();
  await expect(s.cache.get("owner", async () => { throw new Error("cookie dead"); })).rejects.toThrow("cookie dead");
  expect((await s.cache.get("owner", s.mint)).accessToken).toBe("AT1");
});

test("put stores a session minted elsewhere (the shop's), with a fresh clock", async () => {
  const s = setup();
  s.cache.put("owner", session(99));
  expect((await s.cache.get("owner", s.mint)).accessToken).toBe("AT99");
  expect(s.mints()).toBe(0);
});
