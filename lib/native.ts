// Native addons (.node files) cannot be imported as ESM, so use createRequire.
import { createRequire } from "module";

const require = createRequire(import.meta.url);

/** The resolved, frozen config that crosses the JS/native boundary. */
export interface NativeConfig {
	mode: 0 | 1; // 0 = fast (SBBF), 1 = classic
	blockBits: 256 | 512;
	k: number;
	nblk: number;
	hashId: 0 | 1 | 2; // rapidhash | xxh3 | siphash
	seed: bigint;
	initialBytes?: Uint8Array;
}

/** Native instance surface (the marshalling-tier API). */
export interface NativeBloom {
	add(key: string | Uint8Array): void;
	has(key: string | Uint8Array): boolean;
	addAll(keys: Array<string | Uint8Array>): number;
	hasAll(keys: Array<string | Uint8Array>): Uint8Array;
	addHashes(hashes: BigUint64Array): number;
	hasHashes(hashes: BigUint64Array): Uint8Array;
	addInts(ints: Uint32Array | BigUint64Array): number;
	hasInts(ints: Uint32Array | BigUint64Array): Uint8Array;
	addDelimited(buf: Uint8Array, delim: number): number;
	ingestFile(path: string, delim: number): number;
	ingestFileAsync(path: string, delim: number): Promise<number>;
	ingestFileMmap(path: string, delim: number): Promise<number>;
	ingestPush(chunk: Uint8Array, delim: number): number;
	ingestEnd(): number;
	buffer(): ArrayBuffer;
	orWith(other: NativeBloom): void;
	andWith(other: NativeBloom): void;
}

interface Addon {
	Bloom: new (cfg: NativeConfig) => NativeBloom;
	kernelName: string;
}

const addon = require("../build/Release/addon.node") as Addon;

export const BloomNative = addon.Bloom;
/** Which SIMD kernel the runtime dispatch selected at load. */
export const kernelName = addon.kernelName;
