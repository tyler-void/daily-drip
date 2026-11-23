import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, importSpikeJar, loadState, saveState } from "../src/state.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a missing state file gives an empty state", async () => {
  expect(await loadState(join(dir, "state.json"))).toEqual(emptyState());
});

test("save then load round-trips and leaves no temp file", async () => {
  const path = join(dir, "data", "state.json");
  const state = emptyState();
  state.cookie = { jar: { ssid: "a" }, sourceHash: "h" };
  state.shard = "ap";
  state.flags.cookieDeadNotified = true;
  await saveState(state, path);
  expect(await loadState(path)).toEqual(state);
  expect(await readdir(join(dir, "data"))).toEqual(["state.json"]);
});

test.skipIf(process.platform === "win32")("the state file is mode 0600", async () => {
  const path = join(dir, "state.json");
  await saveState(emptyState(), path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("older state files get the missing fields filled in", async () => {
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify({ version: 1, shard: "ap", flags: { blockedNotified: true } }));
  const state = await loadState(path);
  expect(state.shard).toBe("ap");
  expect(state.cookie).toBeNull();
  expect(state.flags).toEqual({ cookieDeadNotified: false, blockedNotified: true, badClaimsNotified: false, deadManNotified: false });
});

test("a corrupt state file is moved aside and the state starts empty", async () => {
  const path = join(dir, "state.json");
  await writeFile(path, "{ not json");
  expect(await loadState(path)).toEqual(emptyState());
  const files = await readdir(dir);
  expect(files.some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("importSpikeJar takes the spike's jar when it started from the same cookie file", async () => {
  const spike = join(dir, "spike-jar.json");
  await writeFile(spike, JSON.stringify({ sourceHash: "h1", jar: { ssid: "rotated" } }));
  const state = emptyState();
  expect(await importSpikeJar(state, "h1", spike)).toBe(true);
  expect(state.cookie).toEqual({ jar: { ssid: "rotated" }, sourceHash: "h1" });
  expect(existsSync(spike)).toBe(false);
  expect(JSON.parse(await readFile(`${spike}.imported`, "utf8")).jar.ssid).toBe("rotated");
});

test("importSpikeJar ignores a spike jar from another cookie file, or when a jar exists", async () => {
  const spike = join(dir, "spike-jar.json");
  await writeFile(spike, JSON.stringify({ sourceHash: "old", jar: { ssid: "x" } }));
  expect(await importSpikeJar(emptyState(), "new", spike)).toBe(false);

  const withJar = emptyState();
  withJar.cookie = { jar: { ssid: "mine" }, sourceHash: "old" };
  expect(await importSpikeJar(withJar, "old", spike)).toBe(false);
  expect(withJar.cookie.jar.ssid).toBe("mine");
});
