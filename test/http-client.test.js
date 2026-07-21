'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { makeRequest } = require('../lib/http-client');

// Boot an in-process server that accepts the connection but never writes a
// response. This reproduces the 2026-05-28 prod hang where a Cloudflare-fronted
// PUT kept the socket "active" without ever responding, so the node-level
// socket-idle `timeout` never fired and the Promise hung indefinitely.
function startBlackholeServer() {
  return new Promise((resolve) => {
    const heldSockets = new Set();
    const server = http.createServer((req, _res) => {
      // Hold the request socket; never write headers or body.
      heldSockets.add(req.socket);
      req.socket.on('close', () => heldSockets.delete(req.socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () =>
          new Promise((res) => {
            for (const s of heldSockets) s.destroy();
            server.close(() => res());
          })
      });
    });
  });
}

test('makeRequest rejects with ERR_REQUEST_DEADLINE when server never responds', async () => {
  const server = await startBlackholeServer();
  try {
    const started = Date.now();
    await assert.rejects(
      makeRequest({
        baseUrl: `http://127.0.0.1:${server.port}`,
        endpoint: '/hang',
        method: 'GET',
        apiName: 'TestAPI',
        // Pick a deadline much shorter than the socket-idle timeout so we
        // prove the deadline path is what's firing, not the existing
        // req.on('timeout') handler.
        deadline: 250,
        timeout: 60000
      }),
      (err) => {
        assert.equal(err.code, 'ERR_REQUEST_DEADLINE');
        assert.match(err.message, /deadline exceeded.*TestAPI/);
        return true;
      }
    );
    const elapsed = Date.now() - started;
    // Should reject roughly at the deadline, not at the socket timeout.
    // Allow generous slack for slow CI.
    assert.ok(elapsed >= 200, `rejected too fast: ${elapsed}ms`);
    assert.ok(elapsed < 5000, `rejected too slow: ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test('makeRequest still resolves normal responses without firing the deadline', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-WP-TotalPages': '3' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await makeRequest({
      baseUrl: `http://127.0.0.1:${port}`,
      endpoint: '/ok',
      method: 'GET',
      apiName: 'TestAPI',
      deadline: 5000
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(result.headers['x-wp-totalpages'], '3');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
