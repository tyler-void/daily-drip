// The run lock (spec: Bot): scheduled runs and /shop never reauth at the same time,
// because overlapping reauths would both rotate the cookie and one rotation would be lost.

export type WithLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLock(): WithLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {}); // a failed run must not block the next one
    return result;
  };
}
