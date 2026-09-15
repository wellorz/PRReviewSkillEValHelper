export type AsyncGate = {
  run<T>(action: () => Promise<T>): Promise<T>;
};

export function createAsyncGate(limit: number): AsyncGate {
  const capacity = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<() => void> = [];

  async function acquire() {
    if (active < capacity) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  }

  function release() {
    active -= 1;
    waiters.shift()?.();
  }

  return {
    async run<T>(action: () => Promise<T>) {
      await acquire();
      try {
        return await action();
      } finally {
        release();
      }
    },
  };
}
