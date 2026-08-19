import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { initCastServer, EGO_INPUT_WS_ROUTE, EGO_FRAMES_WS_ROUTE } from "../lib/cast-server.js";
import { encodeFramePacket } from "../lib/frame-packet.js";

// End-to-end tests of the watch-panel WebSocket routes:
//   browser --WS--> host (cast-server registerUpgrade) --HTTP--> mock worker
//   worker response / stream --WS--> browser
// The mock worker is a plain node:http server that answers /api/health,
// /api/input (for the input WS) and /api/frames/raw (for the frames WS);
// ego-cast.json is pointed at it so ensureWorker() short-circuits without
// spawning the real ego-cast-worker.mjs subprocess.

describe("cast server input WebSocket", () => {
  let workerServer;
  let webServer;
  let webServerPort;
  let stateDir;
  let origStateDir;
  let disposeCast;
  // Pending /api/frames/raw packets the mock worker will push to the next
  // raw client. Tests enqueue packets here; the worker endpoint drains
  // them on connect and on `res.on('drain')`.
  const workerFrames = [];
  const frameFlushers = new Set();

  before(async () => {
    // Mock worker: /api/health for ensureWorker liveness, /api/input for the
    // proxied pointer/keyboard intention. A `targetId: "stale"` body mirrors
    // the worker's capture-target-stale 409 path so the host's WS response
    // carries the same status the legacy HTTP route returned.
    workerServer = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (url.pathname === "/api/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ workerOk: true }));
          return;
        }
        if (url.pathname === "/api/input") {
          let parsed = {};
          try { parsed = JSON.parse(body || "{}"); } catch {}
          if (parsed.targetId === "stale") {
            res.writeHead(409, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "capture-target-stale" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, dispatched: true, echo: parsed }));
          return;
        }
        // /api/frames/raw — emit a sequence of length-prefixed packets so
        // the host's WS proxy can reassemble them and forward (text header,
        // binary jpeg) pairs to the browser. The test driver controls which
        // frames get emitted via workerFrames (a queue of pending packets).
        if (url.pathname === "/api/frames/raw") {
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
          let alive = true;
          const flush = () => {
            if (!alive) return;
            while (workerFrames.length > 0) {
              const packet = workerFrames.shift();
              try {
                if (!res.write(packet)) { workerFrames.unshift(packet); return; }
              } catch (e) { alive = false; frameFlushers.delete(flush); return; }
            }
          };
          frameFlushers.add(flush);
          flush();
          res.on("drain", flush);
          res.on("close", () => { alive = false; frameFlushers.delete(flush); });
          res.on("error", () => { alive = false; frameFlushers.delete(flush); });
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
    const workerPort = workerServer.address().port;

    // Point ensureWorker at the mock worker via ego-cast.json. castStatePath()
    // appends ego-lite-linux/ego-cast.json unless the state dir already ends
    // with that segment, so mirror the real layout under our temp dir.
    stateDir = join(tmpdir(), `ego-cast-test-${process.pid}-${Date.now()}`);
    const stateLeaf = join(stateDir, "ego-lite-linux");
    mkdirSync(stateLeaf, { recursive: true });
    writeFileSync(
      join(stateLeaf, "ego-cast.json"),
      JSON.stringify({ port: workerPort, pid: process.pid }),
    );
    origStateDir = process.env.EGO_LINUX_STATE_DIR;
    process.env.EGO_LINUX_STATE_DIR = stateDir;

    // Mock DSH webServer: a real node:http server (so WS upgrade actually
    // fires) plus the register/registerUpgrade bookkeeping methods the
    // WebServer service exposes. HTTP routes are no-op for this test (we
    // only exercise the upgrade path); upgrade handlers are dispatched by
    // pathname exactly like the real service.
    const upgrades = new Map();
    webServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
    webServer.register = () => () => {};
    webServer.registerUpgrade = (route) => {
      upgrades.set(route.path, route.handler);
      return () => { upgrades.delete(route.path); };
    };
    webServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://x");
      const handler = upgrades.get(url.pathname);
      if (handler) handler(req, socket, head);
      else socket.destroy();
    });
    await new Promise((resolve) => webServer.listen(0, "127.0.0.1", resolve));
    webServerPort = webServer.address().port;

    const disposeFns = [];
    const ctx = {
      webServer,
      effect: (fn) => {
        if (typeof fn === "function") disposeFns.push(fn());
        else if (fn && typeof fn.next === "function") {
          // generator form: drain to collect disposers
          for (const value of fn) if (typeof value === "function") disposeFns.push(value);
        }
        return () => { while (disposeFns.length) { try { disposeFns.pop()() } catch {} } };
      },
      logger: { warn: () => {} },
    };
    initCastServer(ctx, {}, {}, null);
    disposeCast = () => { while (disposeFns.length) { try { disposeFns.pop()() } catch {} } };
  });

  after(async () => {
    try { disposeCast() } catch {}
    if (origStateDir === undefined) delete process.env.EGO_LINUX_STATE_DIR;
    else process.env.EGO_LINUX_STATE_DIR = origStateDir;
    rmSync(stateDir, { recursive: true, force: true });
    workerFrames.length = 0;
    frameFlushers.clear();
    await new Promise((resolve) => workerServer.close(resolve));
    await new Promise((resolve) => webServer.close(resolve));
  });

  function openWs() {
    const ws = new WebSocket(`ws://127.0.0.1:${webServerPort}${EGO_INPUT_WS_ROUTE}`);
    return new Promise((resolve, reject) => {
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function openFramesWs() {
    const ws = new WebSocket(`ws://127.0.0.1:${webServerPort}${EGO_FRAMES_WS_ROUTE}`);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function nextMessage(ws) {
    return new Promise((resolve) => {
      const handler = (data) => {
        ws.off("message", handler);
        try { resolve(JSON.parse(data.toString())); } catch (e) { resolve(null); }
      };
      ws.on("message", handler);
    });
  }

  function nextText(ws) {
    return new Promise((resolve) => {
      const handler = (data, isBinary) => {
        if (isBinary) return; // skip binary frames
        ws.off("message", handler);
        try { resolve(JSON.parse(data.toString())) } catch (e) { resolve(null) }
      };
      ws.on("message", handler);
    });
  }

  function nextBinary(ws) {
    return new Promise((resolve) => {
      const handler = (data, isBinary) => {
        if (!isBinary) return; // skip text frames
        ws.off("message", handler);
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
      };
      ws.on("message", handler);
    });
  }

  function flushWorkerFrames() {
    for (const flush of frameFlushers) try { flush() } catch {}
  }

  it("proxies a normal input event and pushes the worker response back", async () => {
    const ws = await openWs();
    const response = nextMessage(ws);
    ws.send(JSON.stringify({ targetId: "tab-1", type: "mouseMoved", x: 10, y: 20 }));
    const msg = await response;
    assert.equal(msg.ok, true);
    assert.equal(msg.status, 200);
    assert.equal(msg.body.dispatched, true);
    assert.equal(msg.body.echo.targetId, "tab-1");
    assert.equal(msg.body.echo.x, 10);
    ws.close();
  });

  it("surfaces a 409 capture-target-stale response for stale targets", async () => {
    const ws = await openWs();
    const response = nextMessage(ws);
    ws.send(JSON.stringify({ targetId: "stale", type: "mousePressed", x: 5, y: 5 }));
    const msg = await response;
    assert.equal(msg.ok, false);
    assert.equal(msg.status, 409);
    assert.equal(msg.body.code, "capture-target-stale");
    ws.close();
  });

  it("rejects an invalid JSON frame without dropping the connection", async () => {
    const ws = await openWs();
    const response = nextMessage(ws);
    ws.send("not-json");
    const msg = await response;
    assert.equal(msg.ok, false);
    assert.equal(msg.code, "bad-json");
    // Connection stays open: a subsequent valid frame still works.
    const response2 = nextMessage(ws);
    ws.send(JSON.stringify({ targetId: "tab-2", type: "mouseWheel", deltaY: 100 }));
    const msg2 = await response2;
    assert.equal(msg2.ok, true);
    ws.close();
  });

  it("frames WS forwards a paired (text header, binary jpeg) sequence per frame", async () => {
    const ws = await openFramesWs();
    const header = { targetId: "tab-1", vw: 800, vh: 600, ts: 12345, gen: 1, backstop: false };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0x00, 0x00, 0xff, 0xd9]);
    // Register listeners BEFORE flushing frames — WS message events are not
    // buffered, so a handler attached after the host sends would miss it.
    const headerP = nextText(ws);
    const jpegP = nextBinary(ws);
    workerFrames.push(encodeFramePacket(header, jpeg));
    flushWorkerFrames();
    const gotHeader = await headerP;
    const gotJpeg = await jpegP;
    assert.equal(gotHeader.targetId, "tab-1");
    assert.equal(gotHeader.vw, 800);
    assert.equal(gotHeader.ts, 12345);
    assert.equal(gotHeader.size, jpeg.length);
    assert.equal(gotJpeg.toString("hex"), jpeg.toString("hex"));
    ws.close();
  });

  it("frames WS delivers multiple frames in order", async () => {
    workerFrames.length = 0; // clear any leftover from prior test
    // Allow the prior test's WS close → host cleanup → upstream destroy →
    // worker res close chain to finish before opening a new connection,
    // so the old flusher is removed from frameFlushers and can't race us.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ws = await openFramesWs();
    const packets = [
      encodeFramePacket({ targetId: "a", ts: 1, size: 2 }, Buffer.from([1, 2])),
      encodeFramePacket({ targetId: "b", ts: 2, size: 3 }, Buffer.from([3, 4, 5])),
      encodeFramePacket({ targetId: "c", ts: 3, size: 4 }, Buffer.from([6, 7, 8, 9])),
    ];
    // Pre-register a collector that gathers all (text, binary) pairs in
    // arrival order — attaching per-frame nextText/nextBinary sequentially
    // would race the host's immediate paired sends.
    const collected = [];
    const collect = new Promise((resolve) => {
      let pendingHeader = null;
      const onMessage = (data, isBinary) => {
        if (!isBinary) {
          try { pendingHeader = JSON.parse(data.toString()); } catch (e) { pendingHeader = null; }
        } else {
          if (!pendingHeader) return;
          collected.push({ header: pendingHeader, jpeg: Buffer.isBuffer(data) ? data : Buffer.from(data) });
          pendingHeader = null;
          if (collected.length === packets.length) {
            ws.off("message", onMessage);
            resolve();
          }
        }
      };
      ws.on("message", onMessage);
    });
    for (const p of packets) workerFrames.push(p);
    flushWorkerFrames();
    await collect;
    for (let i = 0; i < packets.length; i++) {
      const expected = packets[i];
      const headerLen = expected.readUInt32LE(0);
      const expectedHeader = JSON.parse(expected.subarray(4, 4 + headerLen).toString("utf8"));
      const expectedJpeg = expected.subarray(4 + headerLen);
      assert.equal(collected[i].header.targetId, expectedHeader.targetId);
      assert.equal(collected[i].header.ts, expectedHeader.ts);
      assert.equal(collected[i].jpeg.toString("hex"), expectedJpeg.toString("hex"));
    }
    ws.close();
  });

  it("frames WS handles chunked delivery across multiple worker writes", async () => {
    workerFrames.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ws = await openFramesWs();
    const header = { targetId: "chunk", ts: 99, size: 5 };
    const jpeg = Buffer.from([10, 20, 30, 40, 50]);
    const packet = encodeFramePacket(header, jpeg);
    const headerP = nextText(ws);
    const jpegP = nextBinary(ws);
    // Split the packet into two writes; the host's stream parser must
    // buffer the partial first chunk and complete the frame on the second.
    const mid = Math.floor(packet.length / 2);
    workerFrames.push(packet.subarray(0, mid));
    flushWorkerFrames();
    // Give the host a beat to consume the partial (no frame should arrive).
    await new Promise((resolve) => setTimeout(resolve, 50));
    workerFrames.push(packet.subarray(mid));
    flushWorkerFrames();
    const gotHeader = await headerP;
    const gotJpeg = await jpegP;
    assert.equal(gotHeader.targetId, "chunk");
    assert.equal(gotJpeg.toString("hex"), jpeg.toString("hex"));
    ws.close();
  });
});
