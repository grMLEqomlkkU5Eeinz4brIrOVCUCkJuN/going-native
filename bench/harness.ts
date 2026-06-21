/*
 * The measurement core. One honest rule governs everything here: a reported
 * number is a *distribution*, not a single timing.
 *
 * Each workload runs `warmup` untimed iterations (to reach steady-state JIT and
 * warm the table into cache), then `reps` timed iterations. The harness keeps
 * every per-rep throughput and summarises it with a median + bootstrap 95% CI,
 * the fastest run, and a relative spread, so the reader sees both the central
 * estimate and how noisy the machine was. A `setup` hook runs *before each*
 * timed rep and is never timed, which is how insert benchmarks get a fresh,
 * empty filter every rep instead of measuring an already-saturated table.
 */
import { median, bootstrapCI, mad, mulberry32 } from "./stats.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Measurement {
	label: string;
	group: string;
	n: number;
	reps: number;
	/** ops/s for every timed rep (kept so callers can re-stat or serialise). */
	throughput: number[];
	medianTput: number;
	ci: [number, number];
	/** Fastest rep = the least-contended estimate. */
	bestTput: number;
	/** Relative MAD of the *times*, as a %: a quick read on machine noise. */
	relSpreadPct: number;
}

export interface MeasureOpts {
	group?: string;
	reps?: number;
	warmup?: number;
	/** Untimed, runs before each timed rep (e.g. allocate a fresh filter). */
	setup?: () => void;
}

const REPS = Number(process.env.BENCH_REPS ?? 30);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);
const maybeGc = (globalThis as { gc?: () => void }).gc;

function summarise(label: string, group: string, n: number, timesNs: number[]): Measurement {
	const tput = timesNs.map((ns) => n / (ns / 1e9));
	const rng = mulberry32(0x7e57c0de); // fixed seed => reproducible CIs
	const tms = timesNs.map((ns) => ns / 1e6);
	return {
		label,
		group,
		n,
		reps: timesNs.length,
		throughput: tput,
		medianTput: median(tput),
		ci: bootstrapCI(tput, median, rng),
		bestTput: Math.max(...tput),
		relSpreadPct: (mad(tms) / median(tms)) * 100,
	};
}

export function measure(label: string, n: number, fn: () => void, opts: MeasureOpts = {}): Measurement {
	const reps = opts.reps ?? REPS;
	const warmup = opts.warmup ?? WARMUP;
	for (let w = 0; w < warmup; w++) {
		opts.setup?.();
		fn();
	}
	const times: number[] = [];
	for (let r = 0; r < reps; r++) {
		opts.setup?.();
		maybeGc?.(); // collect setup garbage *before* the clock starts
		const t0 = process.hrtime.bigint();
		fn();
		times.push(Number(process.hrtime.bigint() - t0));
	}
	return summarise(label, opts.group ?? "", n, times);
}

export async function measureAsync(label: string, n: number, fn: () => Promise<void>, opts: MeasureOpts = {}): Promise<Measurement> {
	const reps = opts.reps ?? REPS;
	const warmup = opts.warmup ?? WARMUP;
	for (let w = 0; w < warmup; w++) {
		opts.setup?.();
		await fn();
	}
	const times: number[] = [];
	for (let r = 0; r < reps; r++) {
		opts.setup?.();
		maybeGc?.();
		const t0 = process.hrtime.bigint();
		await fn();
		times.push(Number(process.hrtime.bigint() - t0));
	}
	return summarise(label, opts.group ?? "", n, times);
}

// ---- formatting ----------------------------------------------------------

export function fmtTput(opsPerSec: number): string {
	if (opsPerSec >= 1e9) return (opsPerSec / 1e9).toFixed(2) + "B";
	if (opsPerSec >= 1e6) return (opsPerSec / 1e6).toFixed(1) + "M";
	if (opsPerSec >= 1e3) return (opsPerSec / 1e3).toFixed(1) + "K";
	return opsPerSec.toFixed(0);
}

/** One measurement as an aligned row: median [CI] best ±spread. */
export function printRow(m: Measurement): void {
	const med = `${fmtTput(m.medianTput)} ops/s`.padStart(13);
	const ci = `[${fmtTput(m.ci[0])}, ${fmtTput(m.ci[1])}]`.padStart(17);
	const best = `best ${fmtTput(m.bestTput)}`.padStart(11);
	console.log(`  ${m.label.padEnd(36)} ${med}   95% CI ${ci}   ${best}   ±${m.relSpreadPct.toFixed(1)}%`);
}

// ---- export --------------------------------------------------------------

/** Summary CSV (one row per measurement); per-rep arrays stay in the JSON. */
export function measurementsToCsv(ms: Measurement[]): string {
	const head = "group,label,n,reps,median_ops_s,ci_lo_ops_s,ci_hi_ops_s,best_ops_s,rel_spread_pct";
	const rows = ms.map((m) => [m.group, JSON.stringify(m.label), m.n, m.reps, m.medianTput, m.ci[0], m.ci[1], m.bestTput, m.relSpreadPct].join(","));
	return [head, ...rows].join("\n") + "\n";
}

export function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
