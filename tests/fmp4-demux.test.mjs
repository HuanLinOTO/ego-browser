import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFmp4Demuxer, __internals } from "../lib/fmp4-demux.js";

// Test the fMP4 demuxer that powers the WebCodecs direct-decode path. The
// demuxer extracts the AVCDecoderConfigurationRecord (SPS/PPS) from the
// moov and per-sample NALU chunks from moof/mdat pairs, so VideoDecoder
// can be configured and fed EncodedVideoChunks without MSE.

function box(type, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const result = Buffer.alloc(8 + body.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, "ascii");
  body.copy(result, 8);
  return result;
}

// Build a container box that wraps inner boxes as its payload.
function containerBox(type, ...inner) {
  const payload = Buffer.concat(inner);
  return box(type, payload);
}

// Build the 78-byte VisualSampleEntry prefix that precedes child boxes
// inside an avc1 sample entry. Real FFmpeg fMP4 output has this prefix
// (verified via dump-fmp4-init.mjs: avcC box sits at offset 78 within
// avc1 body). Without this, tests pass but the real stream fails because
// findBox parses the fixed fields as box headers.
// Layout (ISO/IEC 14496-12): SampleEntry(8) + VisualSampleEntry fields(70)
// = 78 bytes. We zero-fill; the test only needs findBox to skip them.
function visualSampleEntryPrefix() {
  return Buffer.alloc(78);
}

// Build a realistic avc1 sample entry with VisualSampleEntry prefix + avcC.
function buildAvc1(avcCBody) {
  return containerBox("avc1", visualSampleEntryPrefix(), box("avcC", avcCBody));
}

// Build a minimal avcC body: [version=1][profile=0x42][compat=0xE0][level=0x1E]
// [lengthSize=0xFF (4 bytes)][numSps=1][spsLen=2][sps=00 00][numPps=1][ppsLen=2][pps=00 00]
function minimalAvcC() {
  const body = Buffer.alloc(15);
  body[0] = 1; // version
  body[1] = 0x42; // profile_idc (Baseline)
  body[2] = 0xE0; // constraint_set flags
  body[3] = 0x1E; // level_idc (3.0)
  body[4] = 0xFF; // length_size_minus_one = 3 → 4-byte length
  body[5] = 0xE1; // num_sps = 1 (high nibble reserved 0xE, low nibble 0x1)
  body.writeUInt16BE(2, 6); // sps_len = 2
  body[8] = 0x00; body[9] = 0x00; // sps bytes (dummy)
  body[10] = 1; // num_pps = 1
  body.writeUInt16BE(2, 11); // pps_len = 2
  body[13] = 0x00; body[14] = 0x00; // pps bytes (dummy)
  return body;
}

// Build a trun body with per-sample size and flags (no data_offset).
// flags = 0x000200 (sample-size-present) | 0x000400 (sample-flags-present) = 0x000600
// No data-offset, no sample-duration, no composition-offset, no first-sample-flags.
// Without data_offset, samples start at offset 0 of the mdat payload.
function minimalTrun(sampleCount, sampleSizes, sampleFlags) {
  const body = Buffer.alloc(8 + sampleCount * 8);
  body[0] = 0; // version
  body[1] = 0x00; body[2] = 0x06; body[3] = 0x00; // flags = 0x000600
  body.writeUInt32BE(sampleCount, 4);
  let off = 8;
  for (let i = 0; i < sampleCount; i++) {
    body.writeUInt32BE(sampleSizes[i], off); off += 4; // size
    body.writeUInt32BE(sampleFlags[i], off); off += 4; // flags
  }
  return body;
}

// Build a length-prefixed NALU for testing. naluLengthSize = 4 (from minimalAvcC).
// type 5 = IDR (keyframe), type 1 = non-IDR (delta frame).
function nalu(naluType, payloadLen = 2) {
  const buf = Buffer.alloc(4 + 1 + payloadLen);
  buf.writeUInt32BE(1 + payloadLen, 0); // NALU length (header + payload)
  buf[4] = naluType & 0x1f; // NALU header byte (forbidden=0, ref_idc=0, type)
  return buf;
}

describe("fMP4 demuxer", () => {
  it("parses a minimal init segment and emits { description, codec }", () => {
    const avcCBody = minimalAvcC();
    const avc1 = buildAvc1(avcCBody);
    const stsd = containerBox("stsd", Buffer.alloc(8), avc1); // 8-byte fullbox header
    const stbl = containerBox("stbl", stsd);
    const minf = containerBox("minf", stbl);
    const mdia = containerBox("mdia", minf);
    const trak = containerBox("trak", mdia);
    const moov = containerBox("moov", trak);
    const ftyp = box("ftyp", "isom");
    const init = Buffer.concat([ftyp, moov]);

    const demuxer = createFmp4Demuxer();
    const events = demuxer.push(init);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "init");
    assert.equal(events[0].codec, "avc1.42E01E");
    assert.ok(events[0].description instanceof Buffer);
    assert.equal(events[0].description.toString("hex"), avcCBody.toString("hex"));
  });

  it("emits sample events from moof+mdat pairs", () => {
    // Init segment
    const avcCBody = minimalAvcC();
    const avc1 = buildAvc1(avcCBody);
    const stsd = containerBox("stsd", Buffer.alloc(8), avc1);
    const stbl = containerBox("stbl", stsd);
    const minf = containerBox("minf", stbl);
    const mdia = containerBox("mdia", minf);
    const trak = containerBox("trak", mdia);
    const moov = containerBox("moov", trak);
    const ftyp = box("ftyp", "isom");
    const init = Buffer.concat([ftyp, moov]);

    // Fragment: 2 samples — first an IDR (keyframe), second a non-IDR (delta).
    // NALU data: 4-byte length prefix + 1 header byte + 1 payload byte = 6 bytes each.
    const idrNalu = nalu(5);     // NALU type 5 = IDR
    const nonIdrNalu = nalu(1);  // NALU type 1 = non-IDR
    const trun = box("trun", minimalTrun(2, [idrNalu.length, nonIdrNalu.length], [0x00000000, 0x02000000]));
    const traf = containerBox("traf", trun);
    const moof = containerBox("moof", traf);
    const mdatPayload = Buffer.concat([idrNalu, nonIdrNalu]);
    const mdat = box("mdat", mdatPayload);
    const fragment = Buffer.concat([moof, mdat]);

    const demuxer = createFmp4Demuxer();
    let events = demuxer.push(init);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "init");

    events = demuxer.push(fragment);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "sample");
    assert.equal(events[0].isKey, true);
    assert.equal(events[0].data.toString("hex"), idrNalu.toString("hex"));
    assert.equal(events[1].type, "sample");
    assert.equal(events[1].isKey, false);
    assert.equal(events[1].data.toString("hex"), nonIdrNalu.toString("hex"));
  });

  it("reassembles across chunk boundaries", () => {
    const avcCBody = minimalAvcC();
    const avc1 = buildAvc1(avcCBody);
    const stsd = containerBox("stsd", Buffer.alloc(8), avc1);
    const stbl = containerBox("stbl", stsd);
    const minf = containerBox("minf", stbl);
    const mdia = containerBox("mdia", minf);
    const trak = containerBox("trak", mdia);
    const moov = containerBox("moov", trak);
    const ftyp = box("ftyp", "isom");
    const idrNalu = nalu(5);
    const trun = box("trun", minimalTrun(1, [idrNalu.length], [0x00000000]));
    const traf = containerBox("traf", trun);
    const moof = containerBox("moof", traf);
    const mdat = box("mdat", idrNalu);
    const stream = Buffer.concat([ftyp, moov, moof, mdat]);

    const demuxer = createFmp4Demuxer();
    const allEvents = [];
    // Feed 1-byte chunks
    for (let i = 0; i < stream.length; i += 1) {
      allEvents.push(...demuxer.push(stream.subarray(i, i + 1)));
    }
    assert.equal(allEvents.length, 2);
    assert.equal(allEvents[0].type, "init");
    assert.equal(allEvents[1].type, "sample");
    assert.equal(allEvents[1].data.toString("hex"), idrNalu.toString("hex"));
  });

  it("rejects unexpected boxes in the init segment", () => {
    const demuxer = createFmp4Demuxer();
    assert.throws(() => demuxer.push(box("mdat", "x")), /unexpected MP4 init box mdat/);
  });

  it("rejects unexpected boxes after init", () => {
    const avcCBody = minimalAvcC();
    const avc1 = buildAvc1(avcCBody);
    const stsd = containerBox("stsd", Buffer.alloc(8), avc1);
    const stbl = containerBox("stbl", stsd);
    const minf = containerBox("minf", stbl);
    const mdia = containerBox("mdia", minf);
    const trak = containerBox("trak", mdia);
    const moov = containerBox("moov", trak);
    const ftyp = box("ftyp", "isom");
    const demuxer = createFmp4Demuxer();
    demuxer.push(Buffer.concat([ftyp, moov]));
    assert.throws(() => demuxer.push(box("stco", "x")), /unexpected MP4 media box stco/);
  });

  it("reset clears state", () => {
    const avcCBody = minimalAvcC();
    const avc1 = buildAvc1(avcCBody);
    const stsd = containerBox("stsd", Buffer.alloc(8), avc1);
    const stbl = containerBox("stbl", stsd);
    const minf = containerBox("minf", stbl);
    const mdia = containerBox("mdia", minf);
    const trak = containerBox("trak", mdia);
    const moov = containerBox("moov", trak);
    const ftyp = box("ftyp", "isom");
    const demuxer = createFmp4Demuxer();
    demuxer.push(Buffer.concat([ftyp, moov]));
    demuxer.reset();
    // After reset, init is emitted again when moov arrives
    const events = demuxer.push(Buffer.concat([ftyp, moov]));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "init");
  });

  it("internals: parseAvcC handles truncated input", () => {
    assert.equal(__internals.parseAvcC(null), null);
    assert.equal(__internals.parseAvcC(Buffer.alloc(3)), null);
  });

  it("internals: codecFromSps falls back for short SPS", () => {
    assert.equal(__internals.codecFromSps(null), "avc1.42E01E");
    assert.equal(__internals.codecFromSps(Buffer.alloc(2)), "avc1.42E01E");
    assert.equal(__internals.codecFromSps(Buffer.from([0x67, 0x42, 0xE0, 0x1E])), "avc1.42E01E");
  });

  // Regression test: real FFmpeg fMP4 output uses empty_moov+
  // default_base_moof+frag_keyframe. The avc1 sample entry contains a
  // 78-byte VisualSampleEntry prefix before the avcC child box. Without
  // skipping that prefix, findBox parses the fixed fields as box headers,
  // fails to find avcC, leaves initEmitted=false, and the next moof
  // triggers "unexpected MP4 init box moof". This test uses a real FFmpeg
  // init segment captured via: ffmpeg -movflags empty_moov+... -f mp4 pipe:1
  it("parses real FFmpeg fMP4 init with VisualSampleEntry prefix", () => {
    const fixture = path.join(os.tmpdir(), "ffmpeg-fmp4-init.bin");
    if (!fs.existsSync(fixture)) {
      // Fixture not generated (CI without ffmpeg); skip gracefully
      return;
    }
    const buf = fs.readFileSync(fixture);
    const demuxer = createFmp4Demuxer();
    const events = demuxer.push(buf);
    // Should emit at least an init event + some samples
    const init = events.find((e) => e.type === "init");
    assert.ok(init, "init event not emitted — VisualSampleEntry prefix not skipped?");
    assert.ok(init.codec.startsWith("avc1."), `unexpected codec: ${init.codec}`);
    assert.ok(init.description instanceof Buffer);
    assert.ok(init.description.length > 10, "avcC description too short");
    // Verify samples are emitted too
    const samples = events.filter((e) => e.type === "sample");
    assert.ok(samples.length > 0, "no samples emitted from real FFmpeg fMP4");
  });
});
