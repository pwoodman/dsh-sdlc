/**
 * eval/lib/zstd-frames.mjs — split a concatenated zstd stream into frames.
 *
 * DSH appends every session event as its OWN zstd frame to the same
 * `session.jsonl.zstd` file, so a live log is thousands of back-to-back frames.
 * `zlib.zstdDecompressSync` decodes the FIRST frame and stops, which silently
 * returned one event out of ~9,600 and made the token parser report "no usage"
 * instead of an error. A decoder that quietly under-counts is exactly the kind
 * of metric this harness promises never to produce, so frames are parsed
 * explicitly here.
 *
 * The split is pure JavaScript and follows RFC 8878 frame framing: a frame
 * header (descriptor, optional window/dictionary/content-size fields) followed
 * by blocks, each introduced by a 3-byte little-endian header. No external
 * tool or dependency is required.
 */

const MAGIC_0 = 0x28;
const MAGIC_1 = 0xb5;
const MAGIC_2 = 0x2f;
const MAGIC_3 = 0xfd;

/** True when a zstd frame magic number starts at `off`. */
export function isZstdFrame(buf, off = 0) {
  return (
    off + 3 < buf.length &&
    buf[off] === MAGIC_0 &&
    buf[off + 1] === MAGIC_1 &&
    buf[off + 2] === MAGIC_2 &&
    buf[off + 3] === MAGIC_3
  );
}

/**
 * Byte length of the zstd frame starting at `off`, or null when it cannot be
 * parsed. Parses the header fields and then walks the block headers, which is
 * what makes the boundary exact rather than a guess.
 */
export function frameLength(buf, off = 0) {
  if (!isZstdFrame(buf, off)) return null;
  let p = off + 4;
  if (p >= buf.length) return null;
  const descriptor = buf[p];
  p += 1;
  const contentSizeFlag = (descriptor >> 6) & 3;
  const singleSegment = (descriptor >> 5) & 1;
  const contentChecksum = (descriptor >> 2) & 1;
  const dictionaryFlag = descriptor & 3;
  if ((descriptor >> 3) & 1) return null; // reserved bit must be zero
  if (!singleSegment) p += 1; // Window_Descriptor
  p += [0, 1, 2, 4][dictionaryFlag]; // Dictionary_ID
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag];
  p += contentSizeBytes;
  if (p > buf.length) return null;
  for (;;) {
    if (p + 3 > buf.length) return null;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const lastBlock = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >>> 3;
    if (blockType === 3) return null; // reserved block type
    p += blockType === 1 ? 1 : blockSize; // RLE stores one byte; raw/compressed store `size`
    if (p > buf.length) return null;
    if (lastBlock) break;
  }
  if (contentChecksum) p += 4;
  if (p > buf.length) return null;
  return p - off;
}

/**
 * Split a concatenated zstd stream into its frames.
 * @returns {{frames:Buffer[], errors:number, trailing:number, complete:boolean}}
 *   `trailing` is the count of bytes after the last parsed frame (0 for a
 *   well-formed append log); `complete` is false if anything was left over or a
 *   frame header could not be parsed.
 */
export function splitZstdFrames(buf) {
  const frames = [];
  let errors = 0;
  let off = 0;
  while (off < buf.length) {
    if (!isZstdFrame(buf, off)) {
      errors += 1;
      break;
    }
    const len = frameLength(buf, off);
    if (len == null || len <= 0) {
      errors += 1;
      break;
    }
    frames.push(buf.subarray(off, off + len));
    off += len;
  }
  return { frames, errors, trailing: buf.length - off, complete: errors === 0 && off === buf.length };
}

export default { isZstdFrame, frameLength, splitZstdFrames };
