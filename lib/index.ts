/**
 * thothfilter: a speed-first native Bloom filter.
 *
 * Public surface: construct from a profile + knobs, then use the
 * marshalling-tier API. Config resolution + validation happen here in JS,
 * before crossing to native.
 */
import {
	resolveConfig,
	estimateFpRate,
	HASH_ID,
	MODE_ID,
	type BloomOptions,
	type ResolvedConfig,
} from "./config.js";
import { BloomNative, kernelName, type NativeBloom } from "./native.js";
import { encodeFilter, decodeFilter } from "./serialize.js";
import { Writable } from "node:stream";

/** Resolve a delimiter (a 1-char string or a byte) to a single byte value. */
function delimByte(delimiter: string | number): number {
	const b = typeof delimiter === "number" ? delimiter : delimiter.charCodeAt(0);
	return b & 0xff;
}

/** Options for the streaming/file ingest paths. */
export interface IngestOptions {
	/** Record separator: a 1-char string (default "\n") or a byte value. */
	delimiter?: string | number;
}

export type {
	BloomOptions,
	BuildOptions,
	ResolvedConfig,
	Mode,
	HashName,
	ProfileName,
	BuildStrategy,
} from "./config.js";
export { BloomConfigError } from "./validate.js";
/** The SIMD kernel selected by runtime dispatch at load: "avx2" | "scalar". */
export { kernelName };

export class BloomFilter {
	/** The fully resolved, frozen geometry (what native + the header store). */
	readonly config: Readonly<ResolvedConfig>;
	#native: NativeBloom;

	constructor(opts: BloomOptions = {}, _adopt?: Uint8Array) {
		this.config = Object.freeze(resolveConfig(opts));
		this.#native = new BloomNative({
			mode: MODE_ID[this.config.mode],
			blockBits: this.config.blockBits,
			k: this.config.k,
			nblk: this.config.nblk,
			hashId: HASH_ID[this.config.hash],
			seed: this.config.seed,
			initialBytes: _adopt,
		});
	}

	// Tier 3: single op
	add(key: string | Uint8Array): this {
		this.#native.add(key);
		return this;
	}
	has(key: string | Uint8Array): boolean {
		return this.#native.has(key);
	}

	// Tier 2: JS array batch
	addAll(keys: Array<string | Uint8Array>): number {
		return this.#native.addAll(keys);
	}
	hasAll(keys: Array<string | Uint8Array>): Uint8Array {
		return this.#native.hasAll(keys);
	}

	// Tier 0: zero-marshalling pointer hand-off (the throughput ceiling)
	addHashes(hashes: BigUint64Array): number {
		return this.#native.addHashes(hashes);
	}
	hasHashes(hashes: BigUint64Array): Uint8Array {
		return this.#native.hasHashes(hashes);
	}
	addInts(ints: Uint32Array | BigUint64Array): number {
		return this.#native.addInts(ints);
	}
	hasInts(ints: Uint32Array | BigUint64Array): Uint8Array {
		return this.#native.hasInts(ints);
	}

	// Tier 1: single bulk buffer, native parsing
	addDelimited(buf: Uint8Array, delimiter: string | number = "\n"): number {
		return this.#native.addDelimited(buf, delimByte(delimiter));
	}

	// Tier 1/0: streaming & file ingestion
	/**
	 * Read a file synchronously in native 64 KiB blocks, splitting on the
	 * delimiter, and insert every record. Blocks the event loop; prefer
	 * {@link ingestFileAsync} for anything but small files. Returns the count.
	 */
	ingestFile(path: string, opts: IngestOptions = {}): number {
		return this.#native.ingestFile(path, delimByte(opts.delimiter ?? "\n"));
	}
	/**
	 * Read + insert on a libuv worker thread (Tier 0): the fastest
	 * single-thread path, bypassing JS streams. Resolves with the record count.
	 */
	ingestFileAsync(path: string, opts: IngestOptions = {}): Promise<number> {
		return this.#native.ingestFileAsync(path, delimByte(opts.delimiter ?? "\n"));
	}
	/**
	 * Like {@link ingestFileAsync} but memory-maps the whole file and hands the
	 * mapped region to the hash+insert kernel. Falls back to the buffered
	 * reader on Windows. Resolves with the record count.
	 */
	ingestFileMmap(path: string, opts: IngestOptions = {}): Promise<number> {
		return this.#native.ingestFileMmap(path, delimByte(opts.delimiter ?? "\n"));
	}
	/**
	 * A Node `Writable` whose chunks are split + inserted natively (Tier 1), so
	 * `pipeline(fs.createReadStream(path), filter.createIngestStream())` ingests
	 * with no JS-side parsing. One stream at a time per filter (carry is shared).
	 */
	createIngestStream(opts: IngestOptions = {}): Writable {
		const delim = delimByte(opts.delimiter ?? "\n");
		const native = this.#native;
		return new Writable({
			write(chunk: Buffer, _enc, cb) {
				try {
					native.ingestPush(chunk, delim);
					cb();
				} catch (err) {
					cb(err as Error);
				}
			},
			final(cb) {
				try {
					native.ingestEnd();
					cb();
				} catch (err) {
					cb(err as Error);
				}
			},
		});
	}

	// set ops & persistence
	/** The raw table bytes (a zero-copy view of the external ArrayBuffer). */
	get tableBytes(): Uint8Array {
		return new Uint8Array(this.#native.buffer());
	}

	/** Serialize to a Buffer (full-geometry header ++ table). */
	toBuffer(): Buffer {
		return encodeFilter(this.config, this.#native.buffer());
	}

	/** Reconstruct a filter from a buffer produced by toBuffer(). */
	static fromBuffer(buf: Uint8Array): BloomFilter {
		const { header, table } = decodeFilter(buf);
		const opts: BloomOptions = {
			mode: header.mode,
			blockBits: header.blockBits,
			hash: header.hash,
			seed: header.seed,
			m: header.m,
		};
		if (header.mode === "classic") opts.k = header.k;
		return new BloomFilter(opts, table);
	}

	clone(): BloomFilter {
		return BloomFilter.fromBuffer(this.toBuffer());
	}

	/** In-place union: OR `other` into this filter (identical geometry required). */
	unionInPlace(other: BloomFilter): this {
		this.#native.orWith(other.#native);
		return this;
	}
	/** In-place intersect: AND `other` into this filter. */
	intersectInPlace(other: BloomFilter): this {
		this.#native.andWith(other.#native);
		return this;
	}

	static union(a: BloomFilter, b: BloomFilter): BloomFilter {
		return a.clone().unionInPlace(b);
	}
	static intersect(a: BloomFilter, b: BloomFilter): BloomFilter {
		return a.clone().intersectInPlace(b);
	}

	// introspection
	/** Estimated false-positive rate for `n` inserted keys at this geometry. */
	estimatedFpRate(n: number): number {
		return estimateFpRate(this.config, n);
	}
	/** Total table size in bytes. */
	get byteLength(): number {
		return this.#native.buffer().byteLength;
	}
}

export default BloomFilter;
