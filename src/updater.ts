/** Polling is silent when offline and never interrupts an export with a restart. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export function startUpdatePolling(check: () => Promise<void>, interval = UPDATE_INTERVAL_MS) {
  let checking = false;
  let stopped = false;
  const poll = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      await check();
    } catch {
      // Offline checks must not interfere with editing. Manual checks report errors.
    } finally {
      checking = false;
    }
  };
  const startup = setTimeout(() => void poll(), 2500);
  const timer = setInterval(() => void poll(), interval);
  return () => {
    stopped = true;
    clearTimeout(startup);
    clearInterval(timer);
  };
}
