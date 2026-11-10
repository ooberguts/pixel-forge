import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  connectionConfig,
  createBridge,
  runStdio,
  TOOLS,
  PROTOCOL_VERSION,
} from './pixel-forge-mcp.mjs';

const token = 'test-token-with-at-least-thirty-two-characters';
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 'future-version',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (name, args = {}, id = 2) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: `pixel_forge_${name}`, arguments: args },
});
function bridge(options = {}) {
  return createBridge({ url: 'http://127.0.0.1:47831', token, ...options });
}
async function ready(value) {
  await value.handle(initialize);
  await value.handle(initialized);
  return value;
}
function collect() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    text: () => text,
  };
}

test('connection configuration requires a session token and loopback-only destination', () => {
  assert.equal(connectionConfig({ PIXEL_FORGE_API_TOKEN: token }).url, 'http://127.0.0.1:47831');
  assert.equal(
    connectionConfig({
      PIXEL_FORGE_API_TOKEN: token,
      PIXEL_FORGE_API_URL: 'http://localhost:47832',
    }).url,
    'http://localhost:47832',
  );
  for (const url of [
    'http://example.com',
    'http://127.0.0.1/path',
    'http://user:password@localhost',
    'file:///tmp/api',
    'http://localhost/?token=secret',
  ])
    assert.throws(
      () => connectionConfig({ PIXEL_FORGE_API_TOKEN: token, PIXEL_FORGE_API_URL: url }),
      /loopback/,
    );
  assert.throws(() => connectionConfig({}), /session token/);
  assert.throws(
    () => connectionConfig({ PIXEL_FORGE_API_TOKEN: 'a\r\nAuthorization: other' }),
    /session token/,
  );
});

test('MCP lifecycle negotiates a supported version and declares only the implemented capability', async () => {
  const b = bridge();
  assert.equal(
    (await b.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.code,
    -32002,
  );
  const result = await b.handle(initialize);
  assert.equal(result.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(result.result.capabilities, { tools: {} });
  assert.equal(await b.handle(initialized), null);
  const listing = await b.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(listing.result.tools.length, 15);
  assert.ok(
    listing.result.tools.every(
      (tool) => tool.inputSchema.additionalProperties === false && !('method' in tool),
    ),
  );
  assert.equal((await b.handle(initialize)).error.code, -32600);
  assert.deepEqual((await b.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
});

test('valid tools authenticate and map only to the documented HTTP command', async () => {
  const requests = [];
  const b = await ready(
    bridge({
      fetchImpl: async (url, init) => {
        requests.push({ url, ...init });
        return Response.json({ result: { revision: 'rev-2' } });
      },
    }),
  );
  const result = await b.handle(
    call('edit_sprite', {
      expectedRevision: 'rev-1',
      operations: [{ type: 'pixels', frame: 0, pixels: [{ x: 1, y: 2, rgba: [1, 2, 3, 128] }] }],
    }),
  );
  assert.equal(result.result.isError, false);
  assert.equal(requests[0].url, 'http://127.0.0.1:47831/v1/commands');
  assert.equal(requests[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].redirect, 'error');
  assert.equal(JSON.parse(requests[0].body).method, 'sprite.apply');
  await b.handle(call('connection_status'));
  assert.equal(requests[1].method, 'GET');
  assert.ok(requests[1].url.endsWith('/v1/status'));
});

test('unknown tools and malformed nested arguments never reach the desktop', async () => {
  let calls = 0;
  const b = await ready(
    bridge({
      fetchImpl: async () => {
        calls++;
        return Response.json({ result: {} });
      },
    }),
  );
  const invalid = [
    call('shell', { command: 'echo hi' }),
    call('sprite_state', { path: '/tmp/anything' }),
    call('edit_sprite', {
      expectedRevision: 'rev',
      operations: [{ type: 'pixels', frame: 0, pixels: [{ x: -1, y: 0, rgba: [0, 0, 0, 255] }] }],
    }),
    call('edit_sprite', {
      expectedRevision: 'rev',
      operations: [{ type: 'duration', frame: 0, duration: 0 }],
    }),
    call('edit_sprite', {
      expectedRevision: 'rev',
      operations: [{ type: 'rename', name: 'x', ignored: true }],
    }),
    call('import_sprite', {
      expectedRevision: 'rev',
      format: 'gif',
      name: 'x',
      base64: 'AAAA',
      replace: false,
    }),
    call('configure_converter', { expectedRevision: 'rev', settings: { keyColor: '#GGGGGG' } }),
  ];
  for (const request of invalid) assert.equal((await b.handle(request)).error.code, -32602);
  assert.equal(calls, 0);
});

test('GIF source import forwards explicit replacement and revision through the converter API', async () => {
  const requests = [];
  const b = await ready(
    bridge({
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return Response.json({ result: { revision: 'gif-source' } });
      },
    }),
  );
  const args = {
    expectedRevision: 'source-before',
    replace: true,
    name: 'animation.gif',
    mimeType: 'image/gif',
    base64: 'R0lGODlh',
  };
  const response = await b.handle(call('import_media', args));
  assert.equal(response.result.isError, false);
  assert.deepEqual(requests, [{ method: 'converter.import', params: args }]);
  assert.equal(
    (await b.handle(call('import_media', { ...args, mimeType: 'application/octet-stream' }))).error
      .code,
    -32602,
  );
  assert.equal(requests.length, 1);
});

test('API failures are tool errors and never echo the connection token', async () => {
  const b = await ready(
    bridge({
      fetchImpl: async () => Response.json({ error: `Read-only mode ${token}` }, { status: 403 }),
    }),
  );
  const result = await b.handle(call('undo_sprite', { expectedRevision: 'rev' }));
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Read-only mode/);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('PNG inspection returns native MCP image content; exports return embedded files without duplicate base64', async () => {
  const b = await ready(
    bridge({
      fetchImpl: async (_url, init) => {
        const method = JSON.parse(init.body).method;
        return Response.json({
          result: {
            name: 'frame.png',
            mimeType: method === 'sprite.export' ? 'application/zip' : 'image/png',
            base64: 'aGVsbG8=',
            revision: 'rev',
          },
        });
      },
    }),
  );
  const frame = (await b.handle(call('sprite_frame', { frame: 0 }))).result;
  assert.deepEqual(frame.content[1], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  assert.ok(!frame.content[0].text.includes('base64'));
  const file = (await b.handle(call('export_sprite', { format: 'project' }))).result;
  assert.equal(file.content[1].type, 'resource');
  assert.equal(file.content[1].resource.blob, 'aGVsbG8=');
  assert.equal(file.content[1].resource.uri, 'pixel-forge://export/frame.png');
});

test('response limits cover both declared and streamed bodies, and invalid JSON is recoverable', async () => {
  for (const response of [
    new Response('too big', { headers: { 'content-length': '1000' } }),
    new Response('x'.repeat(1000)),
    new Response('invalid'),
  ]) {
    const b = await ready(bridge({ maxResponseBytes: 100, fetchImpl: async () => response }));
    const result = await b.handle(call('sprite_state'));
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /limit|invalid response/);
  }
});

test('timeouts and cancellation abort waiting without implying a completed edit was reverted', async () => {
  const waitingFetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  const timed = await ready(bridge({ timeoutMs: 10, fetchImpl: waitingFetch }));
  assert.match(
    (await timed.handle(call('sprite_state'))).result.content[0].text,
    /read current state before retrying/,
  );
  const cancelled = await ready(bridge({ fetchImpl: waitingFetch }));
  const pending = cancelled.handle(call('sprite_state', {}, 42));
  assert.equal(
    await cancelled.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 42 },
    }),
    null,
  );
  assert.equal((await pending).result.isError, true);
});

test('stdio framing accepts fragmented UTF-8, excludes notifications, and recovers from parse errors', async () => {
  const b = bridge(),
    output = collect();
  const messages = [initialize, initialized, { jsonrpc: '2.0', id: '日本語', method: 'ping' }];
  const buffer = Buffer.from(
    messages.map((message) => JSON.stringify(message)).join('\n') + '\nnot-json\n',
  );
  await runStdio(
    Readable.from(Array.from(buffer, (byte) => Buffer.from([byte]))),
    output.stream,
    b,
  );
  const responses = output
    .text()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[1].id, '日本語');
  assert.equal(responses[2].error.code, -32700);
});

test('oversized or incomplete stdio messages terminate without accepting trailing commands', async () => {
  for (const text of ['x'.repeat(101), '{"jsonrpc":"2.0"}']) {
    await assert.rejects(
      runStdio(Readable.from([text]), collect().stream, bridge(), { maxMessageBytes: 100 }),
      /limit|newline/,
    );
  }
});

test('JSON-RPC batches are bounded, ordered, and suppress notification-only responses', async () => {
  const b = await ready(bridge());
  assert.equal((await b.handle([initialize])).error.code, -32600);
  assert.equal(await b.handle([initialized]), null);
  const result = await b.handle([
    { jsonrpc: '2.0', id: 8, method: 'ping' },
    initialized,
    { jsonrpc: '2.0', id: 9, method: 'not-found' },
  ]);
  assert.deepEqual(
    result.map((item) => item.id),
    [8, 9],
  );
  assert.equal(result[1].error.code, -32601);
});

test('real stdio subprocess connects to an authenticated loopback API and exits cleanly', async (t) => {
  let authenticated = false;
  const server = createServer((req, res) => {
    authenticated = req.headers.authorization === `Bearer ${token}`;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: { running: true, allowEdits: false } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const child = spawn(process.execPath, ['scripts/pixel-forge-mcp.mjs'], {
    env: {
      ...process.env,
      PIXEL_FORGE_API_URL: `http://127.0.0.1:${server.address().port}`,
      PIXEL_FORGE_API_TOKEN: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdin.end(
    [initialize, initialized, call('connection_status')]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.ok(authenticated);
  const responses = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.match(responses[1].result.content[0].text, /"running":true/);
  assert.ok(!stdout.includes(token));
});
