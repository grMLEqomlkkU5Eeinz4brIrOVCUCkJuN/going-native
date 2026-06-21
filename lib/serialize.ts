/**
 * Zero-copy-ish serialization. The header records the FULL
 * geometry so a reloaded filter is bit-for-bit queryable, and so set ops can
 * reject mismatched operands. Layout (32-byte header, little-endian):
 *
 *   0  magic   "THBF" (4 bytes)
 *   4  version u8
 *   5  mode    u8   (0 fast, 1 classic)
 *   6  hashId  u8   (0 rapidhash, 1 xxh3, 2 siphash)
 *   7  flags   u8   (reserved)
 *   8  blockBits u16
 *  10  k         u16
 *  12  nblk      u32
 *  16  m         u32   (total table bits)
 *  20  seed      u64
 *  28  reserved  u32
 *  32  raw table bytes ...
 */
import { HASH_ID, MODE_ID, type HashName, type Mode, type ResolvedConfig } from "./config.js";

export const HEADER_BYTES = 32;
const MAGIC = 0x46424854; // "THBF" little-endian
export const FORMAT_VERSION = 1;

const HASH_NAME: HashName[] = ["rapidhash", "xxh3", "siphash"];
const MODE_NAME: Mode[] = ["fast", "classic"];

export interface ParsedHeader {
	mode: Mode;
	hash: HashName;
	blockBits: 256 | 512;
	k: number;
	nblk: number;
	m: number;
	seed: bigint;
}

/** Build a single Buffer = header ++ table bytes. The table view is copied in. */
export function encodeFilter(cfg: ResolvedConfig, table: ArrayBuffer): Buffer {
	const out = Buffer.allocUnsafe(HEADER_BYTES + table.byteLength);
	const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
	dv.setUint32(0, MAGIC, true);
	dv.setUint8(4, FORMAT_VERSION);
	dv.setUint8(5, MODE_ID[cfg.mode]);
	dv.setUint8(6, HASH_ID[cfg.hash]);
	dv.setUint8(7, 0);
	dv.setUint16(8, cfg.blockBits, true);
	dv.setUint16(10, cfg.k, true);
	dv.setUint32(12, cfg.nblk, true);
	dv.setUint32(16, cfg.m, true);
	dv.setBigUint64(20, cfg.seed, true);
	dv.setUint32(28, 0, true);
	out.set(new Uint8Array(table), HEADER_BYTES);
	return out;
}

/** Parse a header + return the table bytes view (no copy of the table slice). */
export function decodeFilter(buf: Uint8Array): { header: ParsedHeader; table: Uint8Array } {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (buf.byteLength < HEADER_BYTES || dv.getUint32(0, true) !== MAGIC) {
		throw new Error("BloomFilter.fromBuffer: bad magic, not a thoth filter buffer.");
	}
	const version = dv.getUint8(4);
	if (version !== FORMAT_VERSION) {
		throw new Error(`BloomFilter.fromBuffer: unsupported format version ${version} (expected ${FORMAT_VERSION}).`);
	}
	const header: ParsedHeader = {
		mode: MODE_NAME[dv.getUint8(5)],
		hash: HASH_NAME[dv.getUint8(6)],
		blockBits: dv.getUint16(8, true) as 256 | 512,
		k: dv.getUint16(10, true),
		nblk: dv.getUint32(12, true),
		m: dv.getUint32(16, true),
		seed: dv.getBigUint64(20, true),
	};
	const table = buf.subarray(HEADER_BYTES);
	return { header, table };
}
