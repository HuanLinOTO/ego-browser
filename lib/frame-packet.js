/**
 * Binary frame packet codec for the CDP screencast fast path.
 *
 * Replaces the legacy SSE path (`event: frame\ndata: {base64 jpeg}\n\n`) with
 * a length-prefixed binary stream over WebSocket, removing base64 encoding
 * (+33% size) and SSE text-frame overhead. Worker writes the packet format
 * to a plain HTTP response body; the host reads the stream, reassembles
 * packets across arbitrary chunk boundaries, and emits each frame as a pair
 * of WebSocket messages (text header, then binary JPEG) so the browser can
 * attach the JPEG to an <img> via objectURL without re-encoding.
 *
 * Wire format (all integers little-endian):
 *   [uint32 headerLen][JSON header (headerLen bytes)][JPEG bytes (header.size bytes)]
 *
 * Each packet is self-contained; the parser accumulates chunks until a full
 * packet is available, then yields it. Frames with bogus header lengths or
 * corrupt JSON abort the stream (the host closes the WS; the client
 * reconnects and the worker resumes from the next screencastFrame ack).
 */

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_JPEG_BYTES = 32 * 1024 * 1024;

/**
 * Encode a single frame packet. `header.size` must equal `jpeg.length`;
 * if missing or mismatched it is filled in from the buffer.
 */
export function encodeFramePacket(header, jpeg) {
  const jpegBuf = Buffer.from(jpeg);
  const headerObj = { ...header, size: jpegBuf.length };
  const headerBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  if (headerBuf.length > MAX_HEADER_BYTES) {
    throw new Error(`frame packet header too large: ${headerBuf.length} bytes`);
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  return Buffer.concat([lenBuf, headerBuf, jpegBuf]);
}

/**
 * Streaming parser. Call `push(chunk)` with each inbound Buffer from the
 * worker HTTP response; it returns an array of `{ header, jpeg }` pairs
 * fully reassembled from that chunk (possibly empty, possibly several).
 * Throws on corrupt header length or invalid JSON — the caller should
 * tear down the upstream connection and let the client reconnect.
 */
export function createFramePacketStream() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const frames = [];
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = buffer.length ? Buffer.concat([buffer, next]) : next;
      while (true) {
        if (buffer.length < 4) break;
        const headerLen = buffer.readUInt32LE(0);
        if (headerLen <= 0 || headerLen > MAX_HEADER_BYTES) {
          throw new Error(`invalid frame packet header length: ${headerLen}`);
        }
        const headerEnd = 4 + headerLen;
        if (buffer.length < headerEnd) break;
        let header;
        try {
          header = JSON.parse(buffer.subarray(4, headerEnd).toString('utf8'));
        } catch (error) {
          throw new Error(`invalid frame packet header JSON: ${error.message}`);
        }
        if (!header || typeof header !== 'object') {
          throw new Error('invalid frame packet header: not an object');
        }
        const size = Number(header.size);
        if (!Number.isFinite(size) || size < 0 || size > MAX_JPEG_BYTES) {
          throw new Error(`invalid frame packet jpeg size: ${header.size}`);
        }
        const jpegEnd = headerEnd + size;
        if (buffer.length < jpegEnd) break;
        const jpeg = Buffer.from(buffer.subarray(headerEnd, jpegEnd));
        frames.push({ header, jpeg });
        buffer = buffer.subarray(jpegEnd);
      }
      return frames;
    },
    reset() { buffer = Buffer.alloc(0); },
  };
}
