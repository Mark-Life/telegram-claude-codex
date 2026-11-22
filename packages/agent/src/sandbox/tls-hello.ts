/**
 * The server name in a TLS ClientHello, read so the proxy can hold a tunnel
 * to the name its CONNECT asked for. A shared edge address serves every name
 * it fronts, so the CONNECT host alone does not bound where a tunnel goes.
 */

/** A ClientHello read so far: more bytes needed, or the name it carries. */
export type HelloRead = { done: false } | { done: true; sni?: string };

const HANDSHAKE_RECORD = 0x16;
const CLIENT_HELLO = 0x01;
const SNI_EXTENSION = 0x00_00;
const HOST_NAME = 0x00;
const RECORD_HEADER_BYTES = 5;
/** Version (2) and random (32) at the head of a ClientHello body. */
const HELLO_FIXED_BYTES = 34;
/** The largest plaintext TLS record. */
const MAX_RECORD_BYTES = 16_384;
const TRAILING_DOT = /\.$/u;

/** Bytes a full first record can take; past it the client is refused. */
export const MAX_HELLO_BYTES = RECORD_HEADER_BYTES + MAX_RECORD_BYTES;

const NO_NAME: HelloRead = { done: true };

/** Widths of the length prefixes and integers a ClientHello uses. */
const U8 = 1;
const U16 = 2;
const U24 = 3;

/** A bounds-checked cursor; every read past the end gives undefined. */
const cursor = (bytes: Buffer, start: number, end: number) => {
  let at = start;
  const take = (size: number) => {
    const from = at;
    const fits = from + size <= end;
    at = fits ? from + size : end;
    return fits ? bytes.subarray(from, at) : undefined;
  };
  const uint = (size: typeof U8 | typeof U16 | typeof U24) =>
    take(size)?.readUIntBE(0, size);
  /** A field prefixed by its length in `size` bytes. */
  const vector = (size: typeof U8 | typeof U16) => {
    const length = uint(size);
    return length === undefined ? undefined : take(length);
  };
  return { take, uint, vector };
};

/**
 * The body of the first `[type, length-prefixed body]` entry of `list` whose
 * type is `wanted`, with entries tagged in `tagSize` bytes.
 */
const findEntry = (
  list: Buffer,
  tagSize: typeof U8 | typeof U16,
  wanted: number
) => {
  const entries = cursor(list, 0, list.length);
  let found: Buffer | undefined;
  for (;;) {
    const type = entries.uint(tagSize);
    const body = entries.vector(U16);
    if (type === undefined || body === undefined || type === wanted) {
      found = type === wanted ? body : undefined;
      break;
    }
  }
  return found;
};

/** The `host_name` entry of a `server_name` extension body. */
const hostNameOf = (body: Buffer) => {
  const list = cursor(body, 0, body.length).vector(U16);
  const name = list === undefined ? undefined : findEntry(list, U8, HOST_NAME);
  return name?.toString("latin1").replace(TRAILING_DOT, "").toLowerCase();
};

/** The server name in a whole ClientHello body, if it names one. */
const sniOf = (hello: Buffer) => {
  const body = cursor(hello, 0, hello.length);
  // Fixed head, then session id, cipher suites and compression methods.
  const skipped =
    body.take(HELLO_FIXED_BYTES) !== undefined &&
    body.vector(U8) !== undefined &&
    body.vector(U16) !== undefined &&
    body.vector(U8) !== undefined;
  const extensions = skipped ? body.vector(U16) : undefined;
  const sni =
    extensions === undefined
      ? undefined
      : findEntry(extensions, U16, SNI_EXTENSION);
  return sni === undefined ? undefined : hostNameOf(sni);
};

/**
 * Read the first TLS record of a client. A ClientHello split across records,
 * or anything that is not one, reads as done with no name.
 */
export const readHello = (bytes: Buffer): HelloRead => {
  if (bytes.length < RECORD_HEADER_BYTES) {
    return { done: false };
  }
  const length = bytes.readUInt16BE(RECORD_HEADER_BYTES - U16);
  if (bytes[0] !== HANDSHAKE_RECORD || length > MAX_RECORD_BYTES) {
    return NO_NAME;
  }
  const end = RECORD_HEADER_BYTES + length;
  if (bytes.length < end) {
    return { done: false };
  }
  const handshake = cursor(bytes, RECORD_HEADER_BYTES, end);
  const type = handshake.uint(U8);
  const size = handshake.uint(U24);
  const hello = size === undefined ? undefined : handshake.take(size);
  if (type !== CLIENT_HELLO || hello === undefined) {
    return NO_NAME;
  }
  const sni = sniOf(hello);
  return sni === undefined ? NO_NAME : { done: true, sni };
};
