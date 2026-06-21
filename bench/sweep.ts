/*
 * Table-size sweep: throughput as a function of filter size, to locate the
 * memory-latency wall that the SIMD-ceiling argument rests on.
 *
 * Each key touches one random block, so while the whole table fits in cache the
 * probe is cheap; once the table outgrows L2 then L3, every probe becomes a
 * cache miss and a memory-bound kernel's throughput falls off a cliff. Sweeping
 * n from a few KiB of table up to tens of MiB makes that cliff a figure rather
 * than an assertion. Cache sizes are read from sysfs and printed so the cliff
 * can be lined up against the L2/L3 boundaries.
 *
 * Run: npm run bench:sweep   (THOTH_FORCE_KERNEL pins the kernel as usual)
 */
import { BloomFilter, kernelName } from "../dist/index.js";
import { measure, fmtTput, writeFile, type Measurement } from "./harness.ts";
import { captureEnv, printEnv } from "./env.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Data/unified cache size in bytes at `level`, read from sysfs, or null. */
function cacheBytes(level: number): number | null {
	for (let i = 0; i < 12; i++) {
		const base = `/sys/devices/system/cpu/cpu0/cache/index${i}`;
		try {
			if (Number(readFileSync(`${base}/level`, "utf8").trim()) !== level) continue;
			if (readFileSync(`${base}/type`, "utf8").trim() === "Instruction") continue;
			const sz = readFileSync(`${base}/size`, "utf8").trim();
			const unit = sz.slice(-1);
			const num = Number(sz.slice(0, -1));
			return unit === "K" ? num * 1024 : unit === "M" ? num * 1024 * 1024 : Number(sz);
		} catch {
			// no such cache index; keep scanning
		}
	}
	return null;
}

function nValues(): number[] {
	const max = Number(process.env.BENCH_SWEEP_MAX ?? 16_000_000);
	const out: number[] = [];
	for (let n = 1024; n <= max; n = Math.round(n * 2)) out.push(n);
	return out;
}

interface SweepRow {
	n: number;
	tableBytes: number;
	add: Measurement;
	has: Measurement;
}

function run(): SweepRow[] {
	const reps = Number(process.env.BENCH_REPS ?? 12);
	const warmup = Number(process.env.BENCH_WARMUP ?? 2);
	const rows: SweepRow[] = [];
	for (const n of nValues()) {
		const hashes = new BigUint64Array(n);
		for (let i = 0; i < n; i++) hashes[i] = BigInt(i) * 0x9e3779b97f4a7c15n + 0x1234567n;
		const mk = (): BloomFilter => new BloomFilter({ n, fpRate: 0.01, seed: 1n });
		let bf = mk();
		const add = measure(`addHashes n=${n}`, n, () => bf.addHashes(hashes), { group: "sweep-add", reps, warmup, setup: () => (bf = mk()) });
		const q = mk();
		q.addHashes(hashes);
		const has = measure(`hasHashes n=${n}`, n, () => q.hasHashes(hashes), { group: "sweep-has", reps, warmup });
		rows.push({ n, tableBytes: q.byteLength, add, has });
	}
	return rows;
}

function toCsv(rows: SweepRow[]): string {
	const head = "n,table_bytes,table_kib,add_median_ops_s,add_ci_lo,add_ci_hi,has_median_ops_s,has_ci_lo,has_ci_hi";
	const body = rows.map((r) =>
		[r.n, r.tableBytes, (r.tableBytes / 1024).toFixed(1), r.add.medianTput, r.add.ci[0], r.add.ci[1], r.has.medianTput, r.has.ci[0], r.has.ci[1]].join(","),
	);
	return [head, ...body].join("\n") + "\n";
}

const env = captureEnv();
const l2 = cacheBytes(2);
const l3 = cacheBytes(3);
console.log(`\nthothfilter table-size sweep (kernel=${kernelName})\n`);
printEnv(env, kernelName);
console.log(`  cache: L2=${l2 ? (l2 / 1024).toFixed(0) + " KiB" : "?"}  L3=${l3 ? (l3 / 1024 / 1024).toFixed(1) + " MiB" : "?"}  (the table crossing these is where throughput should drop)\n`);

const rows = run();

console.log("  table size      addHashes        hasHashes     fits");
let crossedL2 = false;
let crossedL3 = false;
for (const r of rows) {
	const kib = r.tableBytes / 1024;
	const fits = l3 && r.tableBytes > l3 ? "RAM" : l2 && r.tableBytes > l2 ? "L3" : "L2";
	const note = (!crossedL2 && l2 && r.tableBytes > l2 && (crossedL2 = true) ? "  <- exceeds L2" : "") + (!crossedL3 && l3 && r.tableBytes > l3 && (crossedL3 = true) ? "  <- exceeds L3" : "");
	const size = kib >= 1024 ? `${(kib / 1024).toFixed(1)} MiB` : `${kib.toFixed(0)} KiB`;
	console.log(`  ${size.padStart(9)}   ${(fmtTput(r.add.medianTput) + " ops/s").padStart(14)}   ${(fmtTput(r.has.medianTput) + " ops/s").padStart(14)}   ${fits.padEnd(3)}${note}`);
}

const stamp = env.date.replace(/[:.]/g, "-");
const path = join("bench", "results", `sweep-${kernelName}-${stamp}.csv`);
writeFile(path, toCsv(rows));
console.log(`\nresults written: ${path}\n`);
