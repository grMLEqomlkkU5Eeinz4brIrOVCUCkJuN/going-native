/**
 * Validation with teaching error messages. Every message states
 * (1) what was passed, (2) why it's invalid, (3) the exact change that fixes it
 * by naming a concrete option, ending with a copy-pasteable corrected call.
 * This table is the only place a newcomer meets the fast/classic + k rule.
 */
import type { BloomOptions, ResolvedConfig, ProfileName } from "./config.js";

export class BloomConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BloomConfigError";
	}
}

interface Ctx {
	lanes: number;
	sizingCount: number;
	profileName: ProfileName;
}

export function validateResolved(cfg: ResolvedConfig, opts: BloomOptions, ctx: Ctx): void {
	// blockBits geometry
	if (cfg.blockBits !== 256 && cfg.blockBits !== 512) {
		throw new BloomConfigError(`BloomFilter: blockBits=${cfg.blockBits} is invalid. Use 256 or 512.`);
	}

	// concurrent profile cannot run un-shared
	if (ctx.profileName === "concurrent" && opts.shared === false) {
		throw new BloomConfigError(`BloomFilter: the "concurrent" profile builds a shared filter and cannot run with shared:false. Drop shared:false to keep the profile, or use profile:"speed" for a single-threaded filter.`);
	}

	// k vs mode geometry
	if (cfg.mode === "fast") {
		const expected = ctx.lanes; // 8 for 256, 16 for 512
		if (opts.k !== undefined && opts.k !== expected) {
			const otherBlock = cfg.blockBits === 256 ? 512 : 256;
			const otherK = cfg.blockBits === 256 ? 16 : 8;
			if (opts.k === otherK) {
				throw new BloomConfigError(`BloomFilter: in fast mode, k must match blockBits: blockBits=${cfg.blockBits} requires k=${expected}, but k=${opts.k} was given. Set k:${expected}, or use blockBits:${otherBlock} with k:${otherK}.`);
			}
			throw new BloomConfigError(`BloomFilter: k=${opts.k} is not valid in fast mode: fast sets k by block geometry (k=8 for blockBits=256, k=16 for blockBits=512). To use k=${opts.k}, pass mode:"classic" (free k, 1..64): new BloomFilter({ mode: "classic", k: ${opts.k} }). Or keep fast and drop k to accept the default ${expected}.`);
		}
	} else {
		// classic: free k, 1..64
		if (!Number.isInteger(cfg.k) || cfg.k < 1 || cfg.k > 64) {
			throw new BloomConfigError(`BloomFilter: k=${cfg.k} is out of range for classic mode: k must be an integer in 1..64. Example: new BloomFilter({ mode: "classic", k: 10, n: 1_000_000, fpRate: 0.01 }).`);
		}
	}

	// hash availability (siphash/xxh3 are later phases)
	if (cfg.hash !== "rapidhash") {
		throw new BloomConfigError(`BloomFilter: hash:"${cfg.hash}" is not yet available in this build: only "rapidhash" is wired today (xxh3 and the "secure"/siphash profile land in later phases). Use the default hash, or profile:"speed".`);
	}

	// seed must be representable
	if (typeof opts.seed === "number" && !Number.isInteger(opts.seed)) {
		throw new BloomConfigError(`BloomFilter: seed=${opts.seed} is invalid. Pass an integer or a bigint. For a reproducible build use new BloomFilter({ ..., seed: 42n }).`);
	}

	// fpRate range
	if (opts.fpRate !== undefined && (opts.fpRate <= 0 || opts.fpRate >= 1)) {
		throw new BloomConfigError(`BloomFilter: fpRate=${opts.fpRate} is out of range. It must be between 0 and 1 (e.g. 0.01 for 1%).`);
	}

	// sizing under/over-specified
	if (opts.bitsPerKey !== undefined && opts.n === undefined) {
		throw new BloomConfigError(`BloomFilter: bitsPerKey needs an expected key count. Pass n alongside it: new BloomFilter({ n: 1_000_000, bitsPerKey: 10 }). Or size directly with { m } or { n, fpRate }.`);
	}
	if (ctx.sizingCount === 0) {
		throw new BloomConfigError(`BloomFilter: table size is unspecified. Provide one of { n, fpRate }, { m }, or { n, bitsPerKey }. Example: new BloomFilter({ n: 1_000_000, fpRate: 0.01 }).`);
	}
	if (ctx.sizingCount > 1) {
		throw new BloomConfigError(`BloomFilter: table size is over-specified. Pass exactly one of { n, fpRate }, { m }, or { n, bitsPerKey }, not ${ctx.sizingCount}. Pick the one that expresses your intent.`);
	}

	if (cfg.nblk < 1 || cfg.m < 1) {
		throw new BloomConfigError(`BloomFilter: resolved table is empty (nblk=${cfg.nblk}). Check that n/fpRate/m produce a positive size.`);
	}
}
