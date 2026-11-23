// Atomic file writes for data/: temp file + rename, so a crash never leaves half a file.

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let writes = 0;

export async function writeFileAtomic(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique temp name, so two writes to the same file can never share one.
  const tmp = `${path}.${process.pid}-${++writes}.tmp`;
  await writeFile(tmp, contents, { mode });
  await chmod(tmp, mode).catch(() => {}); // does nothing on Windows
  await renameWithRetry(tmp, path);
}

// On Windows, replacing a file that an antivirus scanner or the indexer has open
// fails briefly with EPERM, EBUSY or EACCES.
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const retryable = ["EPERM", "EBUSY", "EACCES"].includes(errorCode(err) ?? "");
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

export function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}
