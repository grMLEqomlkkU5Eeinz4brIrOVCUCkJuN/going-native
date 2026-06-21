/*
 * False-positive accuracy study, runnable standalone (`npm run bench:fp`) so the
 * model-vs-delivered question can be answered with many seeds without paying for
 * the full timing suite.
 *
 * Each trial builds an independent filter, inserts nKeys disjoint keys, probes
 * nProbe disjoint absent keys, and records the delivered rate. The model
 * prediction (estimatedFpRate) is then compared against the bootstrap CI of the
 * delivered rates across seeds, so "the model is honest" is a measured claim
 * with error bars rather than an assertion. A persistent gap between the model
 * and the CI is reported as a bias, not hidden.
 */
import { BloomFilter } from "../dist/index.js";
import type { ProfileName } from "../dist/index.js";
import { fileURLToPath } from "node:url";
import { mean, bootstrapCI, mulberry32 } from "./stats.ts";

export interface FpResult {
	profile: ProfileName;
	mode: string;
	bitsPerKey: number;
	/** Predicted rate from the inverted model (estimatedFpRate). */
	model: number;
	/** Mean delivered rate over the seeds. */
	delivered: number;
	ci: [number, number];
	/** SD of a single trial's estimate, the sampling floor below which noise dominates. */
	samplingSd: number;
	seeds: number;
	nKeys: number;
	nProbe: number;
}

export function fpStudy(seeds: number, nKeys = 200_000, nProbe = 200_000, profiles: ProfileName[] = ["speed", "balanced", "memory"]): FpResult[] {
	const results: FpResult[] = [];
	for (const profile of profiles) {
		const delivered: number[] = [];
		let mode = "";
		let bitsPerKey = 0;
		let model = 0;
		for (let s = 0; s < seeds; s++) {
			const bf = new BloomFilter({ profile, n: nKeys, fpRate: 0.01, seed: BigInt(1000 + s) });
			mode = bf.config.mode;
			bitsPerKey = bf.config.m / nKeys;
			model = bf.estimatedFpRate(nKeys);
			for (let i = 0; i < nKeys; i++) bf.add(`ins-${s}-${i}`);
			let fp = 0;
			for (let i = 0; i < nProbe; i++) if (bf.has(`absent-${s}-${i}`)) fp++;
			delivered.push(fp / nProbe);
		}
		const p = mean(delivered);
		results.push({
			profile,
			mode,
			bitsPerKey,
			model,
			delivered: p,
			ci: bootstrapCI(delivered, mean, mulberry32(0xf9 + profile.length)),
			samplingSd: Math.sqrt((p * (1 - p)) / nProbe),
			seeds,
			nKeys,
			nProbe,
		});
	}
	return results;
}

export function printFp(results: FpResult[]): void {
	console.log("False-positive accuracy (model vs delivered, sampled over seeds)");
	console.log("  profile     mode      bits/key   model FP    delivered FP (95% CI)        verdict        1-trial SD");
	for (const r of results) {
		const within = r.model >= r.ci[0] && r.model <= r.ci[1];
		const biasPct = ((r.delivered - r.model) / r.model) * 100;
		const verdict = within ? "matches" : `${biasPct > 0 ? "+" : ""}${biasPct.toFixed(1)}% off`;
		console.log(
			`  ${r.profile.padEnd(10)} ${r.mode.padEnd(8)} ${r.bitsPerKey.toFixed(2).padStart(7)}   ${r.model.toFixed(4)}     ` +
			`${r.delivered.toFixed(4)} [${r.ci[0].toFixed(4)}, ${r.ci[1].toFixed(4)}]   ${verdict.padEnd(12)}   ±${r.samplingSd.toFixed(4)}`,
		);
	}
	const r0 = results[0];
	if (r0) console.log(`  (${r0.seeds} seeds, ${r0.nKeys.toLocaleString()} keys / ${r0.nProbe.toLocaleString()} probes each. "matches" = the model prediction lands inside the delivered CI.)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const seeds = Number(process.env.BENCH_FP_SEEDS ?? 60);
	printFp(fpStudy(seeds));
}
