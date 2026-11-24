// Authenticated encryption for members' refresh tokens at rest (spec: Accounts).
//
// AES-256-GCM through Web Crypto, so there is no native dependency. The key, TOKEN_KEY (32 random
// bytes, base64), lives in .env, outside the data volume. A leaked state.json or backup on its own
// is then not enough to use a member's sign-in. It does NOT protect against someone who has the key
// or root on the running server: the bot must decrypt the token to use it, unattended.

const ALGO = "AES-GCM";
const IV_BYTES = 12;

/** Import TOKEN_KEY. Throws with how to make one if it isn't exactly 32 bytes. */
export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Buffer.from(base64Key.trim(), "base64");
  if (raw.length !== 32) {
    throw new Error("TOKEN_KEY must be 32 random bytes, base64-encoded; make one with `openssl rand -base64 32`");
  }
  return crypto.subtle.importKey("raw", raw, ALGO, false, ["encrypt", "decrypt"]);
}

/** Encrypt a short secret. The output is "iv.ciphertext", both base64; a fresh IV every time. */
export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(plaintext)));
  return `${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;
}

/** Decrypt a value from seal(). Throws if the key is wrong or the value was altered. */
export async function open(key: CryptoKey, sealed: string): Promise<string> {
  const [ivB64, ctB64] = sealed.split(".");
  if (!ivB64 || !ctB64) throw new Error("not a sealed value");
  const plaintext = await crypto.subtle.decrypt({ name: ALGO, iv: Buffer.from(ivB64, "base64") }, key, Buffer.from(ctB64, "base64"));
  return new TextDecoder().decode(plaintext);
}
