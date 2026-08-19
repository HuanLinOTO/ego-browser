/**
 * Fragmented MP4 demuxer for the WebCodecs direct-decode path.
 *
 * The FFmpeg backend emits a standard fMP4 stream (`ftyp`+`moov` init
 * segment, then `moof`+`mdat` fragment pairs). The legacy MSE path feeds
 * these bytes straight into a SourceBuffer; the WebCodecs path needs to
 * extract `EncodedVideoChunk`s (one per sample) and the
 * `AVCDecoderConfigurationRecord` (SPS/PPS) for `VideoDecoder.configure`.
 *
 * This module is a pure-function re-implementation of the box walker in
 * bin/mp4-fragments.mjs: it consumes a Buffer stream, yields init config
 * on the first `moov`, then yields `{ chunk, isKey }` per sample on each
 * `moof`+`mdat` pair. Box parsing follows ISO/IEC 14496-12; only the
 * subset needed for H.264 fMP4 (ftyp, moov, mvhd, trak, tkhd, mdia, mdhd,
 * hdlr, minf, stbl, stsd, avc1, avcC, moof, mfhd, traf, tfhd, trun, mdat)
 * is handled — anything else is skipped.
 */

const BOX_HEADER_SIZE = 8;

function readBoxHeader(buf, offset) {
  if (buf.length < offset + BOX_HEADER_SIZE) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString("ascii", offset + 4, offset + 8);
  let headerSize = BOX_HEADER_SIZE;
  if (size === 1) {
    // 64-bit large size: not expected from our FFmpeg pipeline, but be
    // defensive — if the high 32 bits are nonzero the box is way bigger
    // than anything we'd buffer.
    if (buf.length < offset + 16) return null;
    const hi = buf.readUInt32BE(offset + 8);
    const lo = buf.readUInt32BE(offset + 12);
    size = hi * 0x100000000 + lo;
    headerSize = 16;
  }
  if (size < headerSize) return null;
  return { type, size, headerSize };
}

function iterBoxes(buf, onBox) {
  let offset = 0;
  while (offset < buf.length) {
    const header = readBoxHeader(buf, offset);
    if (!header) return;
    if (offset + header.size > buf.length) return;
    onBox(header.type, buf.subarray(offset + header.headerSize, offset + header.size), buf.subarray(offset, offset + header.size));
    offset += header.size;
  }
}

// Box types whose body starts with a FullBox header (version + flags,
// 4 bytes) — and for stsd an additional 4-byte entry_count — before any
// child boxes. When we descend INTO one of these, skip the header before
// iterating children. Only stsd matters for our avcC extraction path.
const FULLBOX_CONTAINERS = new Set(["stsd", "stsz", "stco", "co64", "mvhd", "mdhd", "tfhd"]);

// Video sample entry types (avc1, hev1, etc.) carry a VisualSampleEntry
// prefix before their child boxes: 8 bytes SampleEntry header (6 reserved
// + 2 data_reference_index) + 70 bytes VisualSampleEntry fields (pre_defined,
// width, height, resolution, frame_count, compressorname, depth, etc.) =
// 78 bytes total. Without skipping this prefix, findBox parses the fixed
// fields as box headers and never sees the real avcC child. Verified
// against real FFmpeg fMP4 output (empty_moov+default_base_moof).
const VISUAL_SAMPLE_ENTRY_TYPES = new Set(["avc1", "avc3", "hev1", "hevc", "hvc1", "hvc3", "av01"]);
const VISUAL_SAMPLE_ENTRY_PREFIX = 78;

function findBox(buf, path) {
  let current = buf;
  let prevType = null;
  for (const target of path) {
    let found = null;
    let searchIn = current;
    if (prevType && FULLBOX_CONTAINERS.has(prevType) && current.length >= 8) {
      searchIn = current.subarray(8);
    } else if (prevType && VISUAL_SAMPLE_ENTRY_TYPES.has(prevType) && current.length >= VISUAL_SAMPLE_ENTRY_PREFIX) {
      searchIn = current.subarray(VISUAL_SAMPLE_ENTRY_PREFIX);
    }
    iterBoxes(searchIn, (type, body) => {
      if (type === target && !found) found = body;
    });
    if (!found) return null;
    current = found;
    prevType = target;
  }
  return current;
}

function findBoxAll(buf, target) {
  const results = [];
  iterBoxes(buf, (type, body) => {
    if (type === target) results.push(body);
  });
  return results;
}

// Parse the AVCDecoderConfigurationRecord from an avcC box body. The body
// starts with a 5-byte fixed prefix (1 byte version, 3 bytes profile/level
// that mirror the SPS, 1 byte NALU length size minus 1), then SPS count +
// SPS entries, then PPS count + PPS entries. We only need the raw record
// bytes — VideoDecoder.configure wants the full avcC data as `description`.
function parseAvcC(avcCBody) {
  if (!avcCBody || avcCBody.length < 7) return null;
  const lengthSizeMinusOne = avcCBody[4] & 0x03;
  const numOfSps = avcCBody[5] & 0x1f;
  let offset = 6;
  const spsList = [];
  for (let i = 0; i < numOfSps; i++) {
    if (offset + 2 > avcCBody.length) return null;
    const spsLen = avcCBody.readUInt16BE(offset);
    offset += 2;
    if (offset + spsLen > avcCBody.length) return null;
    spsList.push(avcCBody.subarray(offset, offset + spsLen));
    offset += spsLen;
  }
  if (offset + 1 > avcCBody.length) return null;
  const numOfPps = avcCBody[offset];
  offset += 1;
  const ppsList = [];
  for (let i = 0; i < numOfPps; i++) {
    if (offset + 2 > avcCBody.length) return null;
    const ppsLen = avcCBody.readUInt16BE(offset);
    offset += 2;
    if (offset + ppsLen > avcCBody.length) return null;
    ppsList.push(avcCBody.subarray(offset, offset + ppsLen));
    offset += ppsLen;
  }
  return { lengthSizeMinusOne, spsList, ppsList, raw: Buffer.from(avcCBody) };
}

// Derive the `avc1.XXXXXX` codec string from the SPS (profile_idc +
// constraint_set flags + level_idc, the first 3 bytes of the SPS NAL).
function codecFromSps(sps) {
  if (!sps || sps.length < 4) return "avc1.42E01E";
  return `avc1.${[sps[1], sps[2], sps[3]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// Parse a trun box body into per-sample { offset, size, isKey }.
// trun layout: 1 byte version, 3 bytes flags, 4 bytes sample_count, then
// optional data_offset (if flag 0x000200 set), optional first_sample_flags
// (if flag 0x000001 set), then per-sample fields in the order dictated by
// the flags. Per-sample fields use bits 8-11 (0x000100/0x000200/0x000400/0x000800),
// NOT bits 2-5 — the ISO 14496-12 spec spaces header flags and per-sample
// flags apart by reserved bits 2-7.
// If trun omits sample_size, fall back to defaults from tfhd/trex; if those
// are also 0 and there's only one sample, use the entire mdat payload size.
function parseTrun(trunBody, mdatOffset, naluLengthSize, defaults, mdatPayloadLen, moofBodyLen) {
  if (!trunBody || trunBody.length < 8) return [];
  const version = trunBody[0];
  const flags = (trunBody[1] << 16) | (trunBody[2] << 8) | trunBody[3];
  const sampleCount = trunBody.readUInt32BE(4);
  let offset = 8;
  const hasDataOffset = (flags & 0x000001) !== 0;
  const hasFirstSampleFlags = (flags & 0x000002) !== 0;
  const hasSampleDuration = (flags & 0x000004) !== 0 || (flags & 0x000100) !== 0;
  const hasSampleSize = (flags & 0x000008) !== 0 || (flags & 0x000200) !== 0;
  const hasSampleFlags = (flags & 0x000010) !== 0 || (flags & 0x000400) !== 0;
  const hasCompositionOffset = (flags & 0x000020) !== 0 || (flags & 0x000800) !== 0;
  let dataOffset = mdatOffset;
  if (hasDataOffset) {
    if (offset + 4 > trunBody.length) return [];
    // trun data_offset is relative to the moof start (when default_base_is_moof).
    // Convert to mdat-payload-relative: subtract moof_total_size + mdat_header_size.
    dataOffset = trunBody.readInt32BE(offset) - (moofBodyLen + 16);
    offset += 4;
  }
  if (hasFirstSampleFlags) {
    if (offset + 4 > trunBody.length) return [];
    offset += 4;
  }
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    if (hasSampleDuration) {
      if (offset + 4 > trunBody.length) return samples;
      offset += 4;
    }
    let size = 0;
    if (hasSampleSize) {
      if (offset + 4 > trunBody.length) return samples;
      size = trunBody.readUInt32BE(offset);
      offset += 4;
    } else {
      size = defaults?.sampleSize || 0;
    }
    let sampleFlags = 0;
    if (hasSampleFlags) {
      if (offset + 4 > trunBody.length) return samples;
      sampleFlags = trunBody.readUInt32BE(offset);
      offset += 4;
    } else {
      sampleFlags = defaults?.sampleFlags || 0;
    }
    if (hasCompositionOffset) {
      if (offset + 4 > trunBody.length) return samples;
      offset += version === 0 ? 4 : 4; // i32 or u32 depending on version; both 4 bytes
    }
    // isKey is a rough hint from sample_flags; the caller should override
    // with NALU-based detection for accuracy (FFmpeg's default_sample_flags
    // often marks all samples in a fragment as I-frames even for P-frames).
    const isKey = (sampleFlags & 0x02000000) === 0; // sample_depends_on != 2
    samples.push({ offset: dataOffset, size, isKey });
    // dataOffset advances only when data-offset-present; subsequent samples
    // pack contiguously, so advance by size.
    dataOffset += size;
  }
  // Fallback: if all samples have size 0 and there's only one sample, it
  // consumes the entire mdat payload. FFmpeg's empty_moov+frag_keyframe
  // output frequently omits sample_size from trun when each fragment has
  // a single sample.
  if (samples.length === 1 && samples[0].size === 0 && mdatPayloadLen > 0) {
    samples[0].size = mdatPayloadLen;
  }
  return samples;
}

// Split an H.264 sample (Annex B or length-prefixed NALU sequence) into
// individual NALUs. fMP4 from FFmpeg uses length-prefixed (AVC) format,
// where each NALU is preceded by its size in `naluLengthSize+1` bytes
// (typically 4). VideoDecoder wants each NALU as a separate chunk OR the
// whole sample as one chunk — both work because the decoder handles
// length-prefixed input when configured with the avcC. Feed the whole
// sample as one chunk (simpler, matches how MediaSource SourceBuffer
// accepts it).
function extractSample(mdatBody, sample, naluLengthSize) {
  if (sample.size <= 0 || sample.offset < 0 || sample.offset + sample.size > mdatBody.length) return null;
  // Return a COPY — VideoDecoder.decode() / EncodedVideoChunk may not
  // correctly handle Buffer views with non-zero byteOffset (subarrays of
  // subarrays deep in the box tree). A standalone copy is safe.
  return Buffer.from(mdatBody.subarray(sample.offset, sample.offset + sample.size));
}

// Detect keyframe by scanning NALU types in the sample data. An IDR slice
// (NALU type 5) means the sample is a keyframe. This is more reliable than
// sample_flags, which FFmpeg often sets to a fragment-wide default that
// doesn't distinguish individual sample types.
function isAvcKeyframe(data, naluLengthSize) {
  const len = data.length;
  let off = 0;
  while (off + naluLengthSize < len) {
    let naluLen = 0;
    for (let i = 0; i < naluLengthSize; i++) naluLen = (naluLen << 8) | data[off + i];
    if (naluLen <= 0 || off + naluLengthSize + naluLen > len) break;
    const naluType = data[off + naluLengthSize] & 0x1f;
    if (naluType === 5) return true; // IDR
    off += naluLengthSize + naluLen;
  }
  return false;
}

/**
 * Streaming demuxer. Call `push(chunk)` with fMP4 bytes; it returns an
 * array of events:
 *   { type: 'init', description, codec }
 *     Emitted once when the moov is fully parsed. `description` is the
 *     raw avcC bytes (AVCDecoderConfigurationRecord) for
 *     VideoDecoder.configure; `codec` is the `avc1.XXXXXX` string.
 *   { type: 'sample', data, isKey, timestamp, duration }
 *     Emitted per H.264 sample. `data` is a Uint8Array view into the
 *     internal buffer (so consume or copy it before the next push).
 */
export function createFmp4Demuxer() {
  let buffer = Buffer.alloc(0);
  let initEmitted = false;
  let naluLengthSize = 4;
  let pendingMoof = null; // moof box body, awaiting its mdat
  let nextTimestamp = 0;
  // Defaults from trex (moov/mvex/trex) — used when trun/tfhd omit sizes/flags.
  let trexDefaults = { sampleSize: 0, sampleFlags: 0 };

  function handleMoov(moovBody) {
    const avcC = findBox(moovBody, ["trak", "mdia", "minf", "stbl", "stsd", "avc1", "avcC"]);
    if (!avcC) return null;
    const parsed = parseAvcC(avcC);
    if (!parsed) return null;
    naluLengthSize = parsed.lengthSizeMinusOne + 1;
    const codec = codecFromSps(parsed.spsList[0]);
    // Parse trex (moov/mvex/trex) for default sample size/flags. FFmpeg's
    // empty_moov output omits per-sample sizes from trun, so we need these
    // defaults (or the mdat-payload fallback in parseTrun).
    const trex = findBox(moovBody, ["mvex", "trex"]);
    if (trex && trex.length >= 24) {
      // trex body: [4 version+flags][4 track_ID][4 def_sample_desc_index]
      // [4 def_sample_duration][4 def_sample_size][4 def_sample_flags]
      trexDefaults = {
        sampleSize: trex.readUInt32BE(16),
        sampleFlags: trex.readUInt32BE(20),
      };
    }
    return { type: "init", description: Buffer.from(parsed.raw), codec };
  }

  // Parse tfhd (moof/traf/tfhd) for per-fragment defaults that override trex.
  function parseTfhdDefaults(trafBody) {
    const tfhd = findBox(trafBody, ["tfhd"]);
    if (!tfhd || tfhd.length < 8) return null;
    const tfhdFlags = (tfhd[1] << 16) | (tfhd[2] << 8) | tfhd[3];
    let offset = 8; // skip version(1)+flags(3)+track_id(4)
    const hasBaseDataOffset = (tfhdFlags & 0x000001) !== 0;
    const hasSampleDescIndex = (tfhdFlags & 0x000002) !== 0;
    const hasDefDuration = (tfhdFlags & 0x000008) !== 0;
    const hasDefSize = (tfhdFlags & 0x000010) !== 0;
    const hasDefFlags = (tfhdFlags & 0x000020) !== 0;
    if (hasBaseDataOffset) offset += 8; // 64-bit, skip
    if (hasSampleDescIndex) offset += 4;
    let defSize = null, defFlags = null;
    if (hasDefDuration) offset += 4;
    if (hasDefSize) { if (offset + 4 > tfhd.length) return null; defSize = tfhd.readUInt32BE(offset); offset += 4; }
    if (hasDefFlags) { if (offset + 4 > tfhd.length) return null; defFlags = tfhd.readUInt32BE(offset); offset += 4; }
    return {
      sampleSize: defSize ?? trexDefaults.sampleSize,
      sampleFlags: defFlags ?? trexDefaults.sampleFlags,
    };
  }

  function handleMoofMdat(moofBody, mdatBody) {
    const traf = findBox(moofBody, ["traf"]);
    if (!traf) return [];
    const trun = findBox(traf, ["trun"]);
    if (!trun) return [];
    const mdatPayload = mdatBody.subarray(8);
    const defaults = parseTfhdDefaults(traf) || trexDefaults;
    const samples = parseTrun(trun, 0, naluLengthSize, defaults, mdatPayload.length, moofBody.length);
    const events = [];
    for (const sample of samples) {
      const data = extractSample(mdatPayload, { ...sample, offset: sample.offset }, naluLengthSize);
      if (!data) continue;
      const timestamp = nextTimestampUs();
      nextTimestamp += 1;
      events.push({ type: "sample", data: Buffer.from(data), isKey: isAvcKeyframe(data, naluLengthSize), timestamp, duration: 0 });
    }
    return events;
  }

  function nextTimestampUs() {
    // Use a small monotonic counter as the timestamp (microseconds).
    // VideoDecoder expects timestamps in microseconds since some arbitrary
    // epoch; Date.now()*1000 produces values ~1.8e15 which can overflow
    // internal comparisons and cause silent decode failures. A counter
    // starting at 0 and incrementing by a nominal frame duration
    // (1000000/fps µs, default 30fps ≈ 33333µs) is safe and monotonic.
    // Exact PTS doesn't matter for live playback — the decoder
    // reassembles presentation order from the bitstream.
    const ts = nextTimestamp;
    nextTimestamp += 33333; // ~30fps frame duration in µs
    return ts;
  }

  return {
    push(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = buffer.length ? Buffer.concat([buffer, next]) : next;
      const events = [];
      while (buffer.length >= BOX_HEADER_SIZE) {
        const header = readBoxHeader(buffer, 0);
        if (!header) break;
        if (buffer.length < header.size) break;
        const boxBody = buffer.subarray(header.headerSize, header.size);
        const boxType = header.type;
        if (!initEmitted) {
          if (boxType !== "ftyp" && boxType !== "moov" && boxType !== "free" && boxType !== "sidx") {
            throw new Error(`unexpected MP4 init box ${boxType}`);
          }
          if (boxType === "moov") {
            const init = handleMoov(boxBody);
            if (init) {
              events.push(init);
              initEmitted = true;
            }
          }
        } else {
          if (boxType === "moof") {
            pendingMoof = boxBody;
          } else if (boxType === "mdat" && pendingMoof) {
            events.push(...handleMoofMdat(pendingMoof, buffer.subarray(0, header.size)));
            pendingMoof = null;
          } else if (boxType !== "free" && boxType !== "sidx") {
            throw new Error(`unexpected MP4 media box ${boxType}`);
          }
        }
        buffer = buffer.subarray(header.size);
      }
      return events;
    },
    end() {
      if (buffer.length !== 0) throw new Error("truncated fMP4 stream");
    },
    reset() {
      buffer = Buffer.alloc(0);
      initEmitted = false;
      naluLengthSize = 4;
      pendingMoof = null;
      nextTimestamp = 0;
      trexDefaults = { sampleSize: 0, sampleFlags: 0 };
    },
  };
}

// Exported for testing
export const __internals = { readBoxHeader, iterBoxes, findBox, findBoxAll, parseAvcC, codecFromSps, parseTrun, extractSample, isAvcKeyframe };
