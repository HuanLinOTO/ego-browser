import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFramePacket, createFramePacketStream } from "../lib/frame-packet.js";

// Binary frame packet codec for the CDP screencast fast path. The parser
// must reassemble packets across arbitrary chunk boundaries (the worker's
// HTTP response is chunked) and reject corrupt headers so the host tears
// down the upstream instead of emitting garbage to the browser.

describe("frame packet codec", () => {
  it("round-trips a single packet with header + JPEG bytes", () => {
    const header = { targetId: "tab-1", vw: 1280, vh: 720, ts: 12345, gen: 7, backstop: false };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    const packet = encodeFramePacket(header, jpeg);
    // [uint32 LE headerLen][header bytes][jpeg bytes]
    const headerLen = packet.readUInt32LE(0);
    const decodedHeader = JSON.parse(packet.subarray(4, 4 + headerLen).toString("utf8"));
    const decodedJpeg = packet.subarray(4 + headerLen);
    assert.equal(decodedHeader.targetId, "tab-1");
    assert.equal(decodedHeader.size, jpeg.length);
    assert.equal(decodedJpeg.toString("hex"), jpeg.toString("hex"));
  });

  it("fills in header.size when missing or stale", () => {
    const packet = encodeFramePacket({ targetId: "x" }, Buffer.from([1, 2, 3]));
    const headerLen = packet.readUInt32LE(0);
    const header = JSON.parse(packet.subarray(4, 4 + headerLen).toString("utf8"));
    assert.equal(header.size, 3);
  });

  it("reassembles packets across arbitrary chunk boundaries", () => {
    const headers = [
      { targetId: "a", ts: 1, size: 4 },
      { targetId: "b", ts: 2, size: 5 },
      { targetId: "c", ts: 3, size: 6 },
    ];
    const jpegs = [
      Buffer.from([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]).subarray(0, 4),
      Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]).subarray(0, 5),
      Buffer.from([0xff, 0xd8, 0x04, 0x05, 0x06, 0x07, 0x08, 0xff, 0xd9]).subarray(0, 6),
    ];
    const stream = Buffer.concat(headers.map((h, i) => encodeFramePacket(h, jpegs[i])));
    const parser = createFramePacketStream();
    const out = [];
    // Feed 1-byte chunks — the parser must accumulate across many calls.
    for (let i = 0; i < stream.length; i += 1) {
      out.push(...parser.push(stream.subarray(i, i + 1)));
    }
    assert.equal(out.length, 3);
    assert.equal(out[0].header.targetId, "a");
    assert.equal(out[0].jpeg.toString("hex"), jpegs[0].toString("hex"));
    assert.equal(out[1].header.targetId, "b");
    assert.equal(out[1].jpeg.toString("hex"), jpegs[1].toString("hex"));
    assert.equal(out[2].header.targetId, "c");
    assert.equal(out[2].jpeg.toString("hex"), jpegs[2].toString("hex"));
  });

  it("yields multiple packets from a single chunk", () => {
    const p1 = encodeFramePacket({ targetId: "x", ts: 1 }, Buffer.from([1, 2]));
    const p2 = encodeFramePacket({ targetId: "y", ts: 2 }, Buffer.from([3, 4, 5]));
    const parser = createFramePacketStream();
    const out = parser.push(Buffer.concat([p1, p2]));
    assert.equal(out.length, 2);
    assert.equal(out[0].header.targetId, "x");
    assert.equal(out[1].header.targetId, "y");
  });

  it("buffers a partial packet until the rest arrives", () => {
    const packet = encodeFramePacket({ targetId: "z", ts: 9 }, Buffer.from([10, 20, 30, 40]));
    const parser = createFramePacketStream();
    const half = parser.push(packet.subarray(0, packet.length - 2));
    assert.deepEqual(half, []);
    const rest = parser.push(packet.subarray(packet.length - 2));
    assert.equal(rest.length, 1);
    assert.equal(rest[0].header.targetId, "z");
    assert.equal(rest[0].jpeg.toString("hex"), Buffer.from([10, 20, 30, 40]).toString("hex"));
  });

  it("rejects a bogus header length", () => {
    const parser = createFramePacketStream();
    const bogus = Buffer.alloc(8);
    bogus.writeUInt32LE(0, 0); // headerLen = 0
    assert.throws(() => parser.push(bogus), /invalid frame packet header length/);
    const parser2 = createFramePacketStream();
    const bogus2 = Buffer.alloc(8);
    bogus2.writeUInt32LE(10_000_000, 0); // headerLen way too large
    assert.throws(() => parser2.push(bogus2), /invalid frame packet header length/);
  });

  it("rejects invalid JSON in the header", () => {
    const parser = createFramePacketStream();
    const badHeader = Buffer.from("{not json}", "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(badHeader.length, 0);
    assert.throws(() => parser.push(Buffer.concat([len, badHeader])), /invalid frame packet header JSON/);
  });

  it("rejects an out-of-range jpeg size", () => {
    const parser = createFramePacketStream();
    const header = Buffer.from(JSON.stringify({ targetId: "x", size: -1 }), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(header.length, 0);
    assert.throws(() => parser.push(Buffer.concat([len, header])), /invalid frame packet jpeg size/);
  });

  it("reset clears buffered bytes", () => {
    const packet = encodeFramePacket({ targetId: "x", ts: 1 }, Buffer.from([1, 2, 3]));
    const parser = createFramePacketStream();
    parser.push(packet.subarray(0, 4)); // partial: only the headerLen
    parser.reset();
    // After reset, the next push starts fresh — the orphan headerLen bytes
    // from before are gone, so feeding the tail of a fresh packet does not
    // accidentally complete the previous one.
    const out = parser.push(packet.subarray(0, packet.length));
    assert.equal(out.length, 1);
    assert.equal(out[0].header.targetId, "x");
  });
});
