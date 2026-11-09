import { afterEach, describe, expect, it, vi } from 'vitest';
import { startUpdatePolling } from './updater';

afterEach(() => vi.useRealTimers());
describe('automatic release checks', () => {
  it('checks after startup and periodically, and stops cleanly', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValue(undefined);
    const stop = startUpdatePolling(check, 10000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7500);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it('does not overlap slow checks and recovers after offline failures', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const check = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            finish = r;
          }),
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const stop = startUpdatePolling(check, 10000);
    await vi.advanceTimersByTimeAsync(20000);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(check).toHaveBeenCalledTimes(3);
    stop();
  });
});
