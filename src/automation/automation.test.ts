import { describe, expect, it } from 'vitest';
import { applySpriteOperations } from './spriteEdits';
import { base64ToBytes, bytesToBase64, assertParams } from './data';
import { executeAutomationCommand, registerAutomationHandlers } from './bridge';
import { createDocument } from '../sprites/model';

describe('atomic sprite automation', () => {
  it('applies RGBA edits, timing and metadata without changing the source', () => {
    const source = createDocument(3, 2, 'source');
    const next = applySpriteOperations(source, [
      { type: 'pixels', frame: 0, pixels: [{ x: 2, y: 1, rgba: [12, 34, 56, 128] }] },
      { type: 'duration', frame: 0, duration: 250 },
      { type: 'pivot', x: 1.5, y: 2 },
      { type: 'tag', name: 'idle', from: 0, to: 0, direction: 'pingpong' },
    ]);
    expect([...next.frames[0].pixels.slice(20)]).toEqual([12, 34, 56, 128]);
    expect(next.frames[0].duration).toBe(250);
    expect(next.pivot).toEqual({ x: 1.5, y: 2 });
    expect(next.tags[0].name).toBe('idle');
    expect(source.frames[0].pixels.every((value) => value === 0)).toBe(true);
    expect(source.frames[0].duration).toBe(100);
    expect(source.tags).toEqual([]);
  });
  it('rejects a later invalid operation without leaving any partial edit', () => {
    const source = createDocument(2, 2);
    expect(() =>
      applySpriteOperations(source, [
        { type: 'pixels', frame: 0, pixels: [{ x: 0, y: 0, rgba: [255, 0, 0, 255] }] },
        { type: 'duration', frame: 0, duration: 9 },
      ]),
    ).toThrow('Frame duration');
    expect(source.frames[0].pixels.every((value) => value === 0)).toBe(true);
  });
  it('rejects unknown fields, bad bounds and oversized edit batches', () => {
    const source = createDocument(2, 2);
    expect(() =>
      applySpriteOperations(source, [{ type: 'rename', name: 'x', shell: 'ignored?' }]),
    ).toThrow('Unknown parameter');
    expect(() =>
      applySpriteOperations(source, [
        { type: 'pixels', frame: 0, pixels: [{ x: 2, y: 0, rgba: [0, 0, 0, 0] }] },
      ]),
    ).toThrow('Pixel X');
    expect(() =>
      applySpriteOperations(source, [
        { type: 'pixels', frame: 0, pixels: Array(4097).fill({ x: 0, y: 0, rgba: [0, 0, 0, 0] }) },
      ]),
    ).toThrow('4096');
    expect(() =>
      applySpriteOperations(source, Array(65).fill({ type: 'rename', name: 'x' })),
    ).toThrow('1–64');
  });
  it('reorders and removes frames, preserves alpha on resize, and keeps at least one frame', () => {
    const source = createDocument(2, 2);
    source.frames[0].pixels.set([10, 20, 30, 127], 4);
    const next = applySpriteOperations(source, [
      { type: 'duplicate_frame', frame: 0 },
      { type: 'duration', frame: 1, duration: 450 },
      { type: 'move_frame', from: 1, to: 0 },
      { type: 'delete_frame', frame: 1 },
      { type: 'resize_canvas', width: 3, height: 1 },
    ]);
    expect(next.frames).toHaveLength(1);
    expect(next.frames[0].duration).toBe(450);
    expect([...next.frames[0].pixels.slice(4, 8)]).toEqual([10, 20, 30, 127]);
    expect(next.pivot).toEqual({ x: 1, y: 1 });
    expect(() => applySpriteOperations(next, [{ type: 'delete_frame', frame: 0 }])).toThrow(
      'at least one',
    );
  });
});

describe('automation data and dispatch boundaries', () => {
  it('round-trips binary payloads and rejects malformed or oversized base64', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    for (const bad of ['', '====', 'data:image/png;base64,AA==', 'AB', 'AA=A'])
      expect(() => base64ToBytes(bad)).toThrow('valid base64');
    expect(() => base64ToBytes('AQID', 2)).toThrow('size limit');
    expect(() => assertParams([], [])).toThrow('object');
  });
  it('dispatches only registered commands, supports internal chaining and cleans up', async () => {
    const stop = registerAutomationHandlers({
      'test.read': (params) => ({ value: params.value }),
      'test.nested': (params, context) => executeAutomationCommand('test.read', params, context),
    });
    try {
      expect(await executeAutomationCommand('test.nested', { value: 42 })).toEqual({ value: 42 });
      await expect(executeAutomationCommand('test.missing')).rejects.toThrow('does not support');
      expect(() => registerAutomationHandlers({ 'test.read': () => null })).toThrow(
        'already registered',
      );
    } finally {
      stop();
    }
    await expect(executeAutomationCommand('test.read')).rejects.toThrow('does not support');
  });
  it('rejects expired deadlines and releases a stalled handler after cancellation', async () => {
    const controller = new AbortController();
    let started = false;
    const stop = registerAutomationHandlers({
      'test.stalled': () => {
        started = true;
        return new Promise(() => {});
      },
    });
    try {
      await expect(
        executeAutomationCommand(
          'test.stalled',
          {},
          { signal: controller.signal, deadline: Date.now() - 1 },
        ),
      ).rejects.toThrow('timed out');
      expect(started).toBe(false);
      const pending = executeAutomationCommand('test.stalled', {}, { signal: controller.signal });
      await Promise.resolve();
      expect(started).toBe(true);
      controller.abort(new Error('stop'));
      await expect(pending).rejects.toThrow('stop');
    } finally {
      stop();
    }
  });
  it('rejects cancelled work before dispatch and before returning asynchronous results', async () => {
    const controller = new AbortController();
    let started = false;
    const stop = registerAutomationHandlers({
      'test.cancel': async (_, context) => {
        started = true;
        controller.abort(new Error('cancelled'));
        context.signal.throwIfAborted();
        return null;
      },
    });
    try {
      await expect(
        executeAutomationCommand('test.cancel', {}, { signal: controller.signal }),
      ).rejects.toThrow('cancelled');
      expect(started).toBe(true);
      started = false;
      await expect(
        executeAutomationCommand('test.cancel', {}, { signal: controller.signal }),
      ).rejects.toThrow('cancelled');
      expect(started).toBe(false);
    } finally {
      stop();
    }
  });
});
