import { useEffect, useLayoutEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface AutomationContext {
  signal: AbortSignal;
  deadline?: number;
}
export function checkAutomationContext(context: AutomationContext) {
  context.signal.throwIfAborted();
  if (context.deadline !== undefined && Date.now() >= context.deadline)
    throw Error('Automation request timed out.');
}
export type AutomationHandler = (
  params: Record<string, unknown>,
  context: AutomationContext,
) => unknown | Promise<unknown>;
export type AutomationHandlers = Record<string, AutomationHandler>;
const handlers = new Map<string, AutomationHandler>();

/** Internal registry also serves isolated command tests; it is not exposed on window. */
export function registerAutomationHandlers(entries: AutomationHandlers) {
  for (const name of Object.keys(entries))
    if (handlers.has(name)) throw Error(`Automation handler already registered: ${name}`);
  for (const [name, handler] of Object.entries(entries)) handlers.set(name, handler);
  return () => {
    for (const [name, handler] of Object.entries(entries))
      if (handlers.get(name) === handler) handlers.delete(name);
  };
}
export function useAutomationHandlers(entries: AutomationHandlers) {
  const current = useRef(entries);
  current.current = entries;
  const names = Object.keys(entries).sort().join('\n');
  useLayoutEffect(
    () =>
      registerAutomationHandlers(
        Object.fromEntries(
          names
            .split('\n')
            .filter(Boolean)
            .map((name) => [
              name,
              (params: Record<string, unknown>, context: AutomationContext) =>
                current.current[name](params, context),
            ]),
        ),
      ),
    [names],
  );
}
export async function executeAutomationCommand(
  method: string,
  params: Record<string, unknown> = {},
  context: AutomationContext = { signal: new AbortController().signal },
) {
  checkAutomationContext(context);
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw Error('Parameters must be an object.');
  const handler = handlers.get(method);
  if (!handler) throw Error(`This editor does not support ${method}.`);
  let removeAbort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () =>
      reject(context.signal.reason ?? new Error('Automation request was cancelled.'));
    context.signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => context.signal.removeEventListener('abort', abort);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        checkAutomationContext(context);
        return handler(params, context);
      }),
      cancelled,
    ]);
    checkAutomationContext(context);
    return result;
  } finally {
    removeAbort();
  }
}
interface Request {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  deadline?: number;
}
/** One native listener per application; no browser route or global bypass. */
export function useAutomationBridge(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const pending = new Map<string, AbortController>();
    const subscriptions = [
      listen<Request>('automation-request', ({ payload }) => {
        const controller = new AbortController();
        pending.set(payload.id, controller);
        const remaining = Math.max(
          0,
          Math.min(55_000, (payload.deadline ?? Date.now() + 55_000) - Date.now()),
        );
        const deadline = Date.now() + remaining;
        if (remaining === 0) controller.abort(new Error('Automation request timed out.'));
        const timer = setTimeout(
          () => controller.abort(new Error('Automation request timed out.')),
          remaining,
        );
        const run = async () => {
          try {
            if (disposed) return;
            const result = await executeAutomationCommand(payload.method, payload.params, {
              signal: controller.signal,
              deadline,
            });
            if (!disposed) await invoke('automation_respond', { id: payload.id, result });
          } catch (error) {
            if (!disposed)
              await invoke('automation_respond', {
                id: payload.id,
                error: error instanceof Error ? error.message : String(error),
              }).catch(() => {});
          } finally {
            clearTimeout(timer);
            pending.delete(payload.id);
          }
        };
        tail = tail.then(run, run);
      }),
      listen<{ id: string }>('automation-cancel', ({ payload }) =>
        pending.get(payload.id)?.abort(new Error('Automation request was cancelled.')),
      ),
    ];
    return () => {
      disposed = true;
      for (const controller of pending.values())
        controller.abort(new Error('Editor session closed.'));
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [enabled]);
}
