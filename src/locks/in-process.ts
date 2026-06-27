const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = prev.then(() => gate);
  fileLocks.set(key, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === mine) {
      fileLocks.delete(key); // self-clean when no waiter chained behind us
    }
  }
}
