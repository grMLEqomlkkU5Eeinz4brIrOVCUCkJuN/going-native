/**
 * Configuration model: pick a profile, override any knob.
 * Resolution order: profile defaults < explicit knobs < derived sizing.
 * Validation (validate.ts) runs after the merge.
 */
import { validateResolved } from "./validate.js";

export type Mode = "fast" | "classic";
export type HashName = "rapidhash" | "xxh3" | "siphash";
export type ProfileName =
	| "speed"
	| "balanced"
	| "memory"
	| "concurrent"
	| "secure";
export type BuildStrategy = "union" | "shared-atomic" | "auto";

export interface BuildOptions {
	strategy?: BuildStrategy;
	threads?: number;
	threshold?: number;
}

export interface BloomOptions {
	// sizing (choose one)
	n?: number;
	fpRate?: number;
	m?: number;
	bitsPerKey?: number;
	// profile
	profile?: ProfileName;
	// structure knobs
	mode?: Mode;
	k?: number;
	blockBits?: 256 | 512;
	hash?: HashName;
	seed?: bigint | number;
	// memory & concurrency
	shared?: boolean;
	build?: BuildOptions;
}

/** A fully resolved, validated config: the source of truth for native + header. */
export interface ResolvedConfig {
	mode: Mode;
	k: number;
	blockBits: 256 | 512;
	hash: HashName;
	seed: bigint;
	shared: boolean;
	build: Required<Pick<BuildOptions, "strategy">> & BuildOptions;
	// sizing results
	n?: number;
	fpRate?: number;
	m: number; // total table bits
	nblk: number;
}

export const HASH_ID: Record<HashName, 0 | 1 | 2> = {
	rapidhash: 0,
	xxh3: 1,
	siphash: 2,
};
export const MODE_ID: Record<Mode, 0 | 1> = { fast: 0, classic: 1 };

interface ProfileDef {
	mode: Mode;
	blockBits: 256 | 512;
	hash: HashName;
	shared: boolean;
	strategy: BuildStrategy;
	/** fixed k for fast profiles; undefined => derive from fpRate (classic). */
	k?: number;
}

const PROFILES: Record<ProfileName, ProfileDef> = {
	speed: { mode: "fast", blockBits: 256, hash: "rapidhash", shared: false, strategy: "union", k: 8 },
	balanced: { mode: "classic", blockBits: 512, hash: "rapidhash", shared: false, strategy: "union" },
	memory: { mode: "classic", blockBits: 512, hash: "rapidhash", shared: false, strategy: "union" },
	concurrent: { mode: "fast", blockBits: 512, hash: "rapidhash", shared: true, strategy: "shared-atomic", k: 16 },
	secure: { mode: "fast", blockBits: 256, hash: "siphash", shared: false, strategy: "union", k: 8 },
};

const DEFAULT_PROFILE: ProfileName = "speed";

// false-positive models (mode-aware)

/** Poisson pmf helper, summed over a sensible range around the mean. */
function poissonExpectation(lambda: number, term: (i: number) => number): number {
	// e^{-lambda} * sum of lambda^i / i! * term(i); iterate until the tail is negligible.
	const cap = Math.max(64, Math.ceil(lambda + 12 * Math.sqrt(lambda + 1)));
	let logPmf = -lambda; // i = 0
	let sum = 0;
	for (let i = 0; i <= cap; i++) {
		sum += Math.exp(logPmf) * term(i);
		logPmf += Math.log(lambda) - Math.log(i + 1);
	}
	return sum;
}

/** SBBF (fast) false-positive rate for n keys across nblk blocks. */
export function sbbfFpRate(n: number, nblk: number, lanes: number): number {
	const lambda = n / nblk; // expected keys per block
	// per non-member query: all `lanes` chosen bits already set in their words.
	return poissonExpectation(lambda, (i) => Math.pow(1 - Math.pow(31 / 32, i), lanes));
}

/** Classic cache-blocked FP rate. The kernel partitions each block into k
 * equal slices and sets one bit per slice, so per key a given slice-bit stays 0
 * with probability (1 - k/blockBits). After i keys in the block its query bit is
 * set with probability 1 - (1 - k/blockBits)^i, and the k slices are
 * independent. Poisson-averaged over per-block load, which the global model
 * misses. */
export function classicFpRate(n: number, nblk: number, k: number, blockBits: number): number {
	const lambda = n / nblk;
	const sliceMiss = 1 - k / blockBits; // P(a given slice bit stays 0) per key
	return poissonExpectation(lambda, (i) => Math.pow(1 - Math.pow(sliceMiss, i), k));
}

/** Solve classic block count for a target FP given n keys, k, lane geometry. */
function classicBlocksFor(n: number, fpRate: number, k: number, blockBits: number): number {
	let lo = 0.5;
	let hi = 64;
	for (let it = 0; it < 60; it++) {
		const bpk = (lo + hi) / 2;
		const nblk = Math.max(1, Math.ceil((n * bpk) / blockBits));
		if (classicFpRate(n, nblk, k, blockBits) <= fpRate) hi = bpk;
		else lo = bpk;
	}
	return Math.max(1, Math.ceil((n * hi) / blockBits));
}

/** Solve SBBF block count for a target FP given n keys & lane count. */
function sbbfBlocksFor(n: number, fpRate: number, lanes: number, blockBits: number): number {
	// monotonic in bitsPerKey; binary-search bits/key in [lanes, 64].
	let lo = lanes / blockBits; // at least one block's worth
	let hi = 64;
	for (let it = 0; it < 60; it++) {
		const bpk = (lo + hi) / 2;
		const nblk = Math.max(1, Math.ceil((n * bpk) / blockBits));
		if (sbbfFpRate(n, nblk, lanes) <= fpRate) hi = bpk;
		else lo = bpk;
	}
	return Math.max(1, Math.ceil((n * hi) / blockBits));
}

function optimalClassicK(fpRate: number): number {
	// k = -log2(p); clamp to the classic free-k range 1..64.
	return Math.min(64, Math.max(1, Math.round(-Math.log2(fpRate))));
}

// resolution

function toBigIntSeed(seed: bigint | number | undefined): bigint {
	if (seed === undefined) {
		// per-instance random seed: 64 bits of crypto randomness.
		const b = new BigUint64Array(1);
		globalThis.crypto.getRandomValues(b);
		return b[0];
	}
	return BigInt.asUintN(64, BigInt(seed));
}

export function resolveConfig(opts: BloomOptions = {}): ResolvedConfig {
	const profileName: ProfileName = opts.profile ?? DEFAULT_PROFILE;
	const prof = PROFILES[profileName];

	// knob wins over profile
	const mode: Mode = opts.mode ?? prof.mode;
	const blockBits = opts.blockBits ?? prof.blockBits;
	const hash: HashName = opts.hash ?? prof.hash;
	const shared = opts.shared ?? prof.shared;
	const strategy: BuildStrategy = opts.build?.strategy ?? prof.strategy;

	const lanes = blockBits === 512 ? 16 : 8;

	// Resolve k. fast: geometry-locked; classic: free or derived.
	let k: number;
	if (mode === "fast") {
		k = opts.k ?? lanes; // default to geometry; explicit wrong k caught in validate
	} else {
		k = opts.k ?? (opts.fpRate !== undefined ? optimalClassicK(opts.fpRate) : prof.k ?? 8);
	}

	// Resolve sizing into m and nblk.
	let m: number;
	let nblk: number;
	const blockBytesBits = blockBits;

	const sizingCount = [opts.n !== undefined && opts.fpRate !== undefined, opts.m !== undefined, opts.bitsPerKey !== undefined].filter(Boolean).length;

	if (opts.m !== undefined) {
		nblk = Math.max(1, Math.ceil(opts.m / blockBytesBits));
		m = nblk * blockBytesBits;
	} else if (opts.bitsPerKey !== undefined) {
		const n = opts.n ?? 0;
		nblk = Math.max(1, Math.ceil((n * opts.bitsPerKey) / blockBytesBits));
		m = nblk * blockBytesBits;
	} else if (opts.n !== undefined && opts.fpRate !== undefined) {
		if (mode === "fast") {
			nblk = sbbfBlocksFor(opts.n, opts.fpRate, lanes, blockBytesBits);
		} else {
			nblk = classicBlocksFor(opts.n, opts.fpRate, k, blockBytesBits);
		}
		m = nblk * blockBytesBits;
	} else {
		// under-specified: validate.ts turns this into a teaching error.
		nblk = 0;
		m = 0;
	}

	const resolved: ResolvedConfig = {
		mode,
		k,
		blockBits,
		hash,
		seed: toBigIntSeed(opts.seed),
		shared,
		build: { strategy, threads: opts.build?.threads, threshold: opts.build?.threshold },
		n: opts.n,
		fpRate: opts.fpRate,
		m,
		nblk,
	};

	validateResolved(resolved, opts, { lanes, sizingCount, profileName });
	return resolved;
}

/** Estimate the FP rate the resolved geometry delivers for `n` keys. */
export function estimateFpRate(cfg: ResolvedConfig, n: number): number {
	const lanes = cfg.blockBits === 512 ? 16 : 8;
	return cfg.mode === "fast" ? sbbfFpRate(n, cfg.nblk, lanes) : classicFpRate(n, cfg.nblk, cfg.k, cfg.blockBits);
}
