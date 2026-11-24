// Refresh-token lifetime spike (S5). Members' sign-in-link refresh tokens were refused by Riot
// (invalid_grant) hours after linking, never having been used. This answers: do they expire when
// idle, and does refreshing them regularly keep them alive?
//
//   bun scripts/refresh-spike.ts link  <file>        sign-in link -> code (from CODE_FILE) -> refresh token in <file>
//   bun scripts/refresh-spike.ts check <file>        one refresh with the token in <file>; saves the newest token
//
// The owner's own account only. Prints statuses and whether the token rotated; never a token.
// <file> is written with mode 600; delete it when done.

import { readFile, rm, writeFile } from "node:fs/promises";
import { createHttp } from "../src/http.ts";
import { addSecret } from "../src/log.ts";
import { buildSignInUrl, exchangeCode, extractCode, LoginDeadError, refreshTokens } from "../src/riot/login.ts";

const [mode, file] = process.argv.slice(2);
if (!file || (mode !== "link" && mode !== "check")) {
  console.log("usage: bun scripts/refresh-spike.ts link|check <file>");
  process.exit(1);
}
const http = createHttp();
const stamp = () => new Date().toISOString().slice(11, 19);

if (mode === "link") {
  const urlFile = process.env.AUTH_URL_FILE ?? "auth-url.txt";
  const codeFile = process.env.CODE_FILE ?? "redirect.txt";
  await writeFile(urlFile, buildSignInUrl(), { mode: 0o600 });
  console.log(`${stamp()} sign-in link ready`);
  const deadline = Date.now() + 5 * 60_000;
  let code: string | null = null;
  while (!code && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const pasted = await readFile(codeFile, "utf8").catch(() => "");
    if (pasted) {
      code = extractCode(pasted);
      await rm(codeFile, { force: true });
    }
  }
  await rm(urlFile, { force: true });
  if (!code) {
    console.log(`${stamp()} FAILED: no redirect address`);
    process.exit(3);
  }
  addSecret(code);
  const tokens = await exchangeCode(http, code);
  addSecret(tokens.refreshToken);
  await writeFile(file, tokens.refreshToken, { mode: 0o600 });
  console.log(`${stamp()} LINKED: refresh token saved (${tokens.refreshToken.length} chars), access token lives ${tokens.expiresInSeconds} s`);
} else {
  const held = (await readFile(file, "utf8")).trim();
  addSecret(held);
  try {
    const tokens = await refreshTokens(http, held);
    addSecret(tokens.refreshToken);
    const rotated = tokens.refreshToken !== held;
    if (rotated) await writeFile(file, tokens.refreshToken, { mode: 0o600 });
    console.log(`${stamp()} REFRESH OK (rotated: ${rotated ? "yes" : "no"})`);
  } catch (err) {
    console.log(`${stamp()} REFRESH FAILED: ${err instanceof LoginDeadError ? "invalid_grant (dead)" : err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
