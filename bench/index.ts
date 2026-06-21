/**
 * thothfilter benchmark. Honesty-first measurement of the marshalling boundary.
 *
 * Three design rules, each a direct response to how a microbenchmark lies:
 *
 *  1. Every number is a distribution. See harness.ts: median + bootstrap 95%
 *     CI over many reps, never a single timing.
 *  2. Only same-work comparisons get a ratio. The headline question ("what
 *     does the language boundary cost?") is answered by a decomposition that
 *     isolates one variable at a time (crossings, then string extraction, then
 *     native hashing). Cross-workload numbers (e.g. vs JS `Set`) are printed but
 *     explicitly flagged, because `Set` stores values and hashes strings: it is
 *     a different computation, not a faster/slower version of the same one.
 *  3. Accuracy is sampled, not asserted. The false-positive study runs many
 *     independent seeds and reports the delivered rate with a CI, next to the
 *     model's prediction and the single-trial sampling floor, so "the model is
 *     honest" is a measured claim with error bars.
 *
 * Modes:
 *   npm run bench              full suite for the loaded kernel
 *   npm run bench:compare      scalar-vs-AVX2 via two pinned child processes
 *
 * Env: BENCH_N, BENCH_REPS, BENCH_WARMUP, BENCH_FP_SEEDS.
 */
import { BloomFilter, kernelName } from "../dist/index.js";
import type { ProfileName } from "../dist/index.js";
import { writeFileSync, rmSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { measure, measureAsync, printRow, fmtTput, measurementsToCsv, writeFile, type Measurement } from "./harness.ts";
import { captureEnv, printEnv, type BenchEnv } from "./env.ts";
import { ciOverlap } from "./stats.ts";
import { fpStudy, printFp, type FpResult } from "./fp.ts";

const N = Number(process.env.BENCH_N ?? 1_000_000);
const FP_SEEDS = Number(process.env.BENCH_FP_SEEDS ?? 24);
const SELF = fileURLToPath(import.meta.url);

// shared inputs (built once)
const strings = Array.from({ length: N }, (_, i) => `key-${i}`);
const ints = new Uint32Array(N);
for (let i = 0; i < N; i++) ints[i] = (i * 2654435761) >>> 0;
const hashes = new BigUint64Array(N);
for (let i = 0; i < N; i++) hashes[i] = BigInt(i) * 0x9e3779b97f4a7c15n + 0x1234567n;

const newFilter = (profile: ProfileName = "speed"): BloomFilter => new BloomFilter({ profile, n: N, fpRate: 0.01, seed: 1n });

// ---- kernel-sensitive benches (the only ones that differ scalar vs AVX2) ----
// Inserts use a fresh empty filter per rep (setup, untimed). Queries reuse one
// pre-populated filter; they never mutate, and for the default SBBF kernel the
// query is data-independent (testc checks all lanes, no early-out), so querying
// present keys is the honest worst case rather than a cherry-picked best one.

function kernelSensitive(): Measurement[] {
	const out: Measurement[] = [];
	{
		let bf = newFilter();
		out.push(measure("addHashes  [SBBF, memory-bound]", N, () => bf.addHashes(hashes), { group: "kernel", setup: () => (bf = newFilter()) }));
	}
	{
		const bf = newFilter();
		bf.addHashes(hashes);
		out.push(measure("hasHashes  [SBBF, memory-bound]", N, () => bf.hasHashes(hashes), { group: "kernel" }));
	}
	{
		let bf = newFilter();
		out.push(measure("addInts    [SBBF, +native hash]", N, () => bf.addInts(ints), { group: "kernel", setup: () => (bf = newFilter()) }));
	}
	// classic control: scalar-only kernel, so AVX2 must NOT show a speedup here.
	{
		let bf = newFilter("balanced");
		out.push(measure("addHashes  [classic, control]", N, () => bf.addHashes(hashes), { group: "kernel", setup: () => (bf = newFilter("balanced")) }));
	}
	// set ops: the OR/AND SIMD path. Throughput in 32-bit word-ops/s.
	{
		const words = newFilter().byteLength / 4;
		let a = newFilter();
		const b = newFilter();
		b.addHashes(hashes);
		out.push(measure("unionInPlace [OR words]", words, () => a.unionInPlace(b), { group: "kernel", setup: () => (a = newFilter()) }));
	}
	return out;
}

// ---- boundary-cost decomposition (the corrected headline) -------------------

function decomposition(): Measurement[] {
	const out: Measurement[] = [];
	// Reference, NOT a tier of this library: JS Set hashes strings AND stores
	// the values. Printed only to make one honest point below.
	out.push(measure("Set.add() loop          [JS baseline]", N, () => {
		const s = new Set<string>();
		for (let i = 0; i < N; i++) s.add(strings[i]);
	}, { group: "decomp" }));

	let bf = newFilter();
	out.push(measure("add() loop      [N crossings]", N, () => {
		for (let i = 0; i < N; i++) bf.add(strings[i]);
	}, { group: "decomp", setup: () => (bf = newFilter()) }));

	out.push(measure("addAll(string[]) [1 crossing]", N, () => bf.addAll(strings), { group: "decomp", setup: () => (bf = newFilter()) }));
	out.push(measure("addInts(Uint32)  [1 crossing, zero-copy]", N, () => bf.addInts(ints), { group: "decomp", setup: () => (bf = newFilter()) }));
	out.push(measure("addHashes(u64)   [1 crossing, no hash]", N, () => bf.addHashes(hashes), { group: "decomp", setup: () => (bf = newFilter()) }));
	return out;
}

// ---- ingestion paths --------------------------------------------------------

async function ingestion(): Promise<Measurement[]> {
	const path = join(tmpdir(), `thoth-bench-${process.pid}.txt`);
	writeFileSync(path, strings.join("\n") + "\n");
	const out: Measurement[] = [];
	let bf = newFilter();
	const reset = (): void => {
		bf = newFilter();
	};
	out.push(measure("ingestFile      [sync fread]", N, () => bf.ingestFile(path), { group: "ingest", setup: reset }));
	out.push(await measureAsync("ingestFileAsync [libuv worker]", N, () => bf.ingestFileAsync(path).then(() => undefined), { group: "ingest", setup: reset }));
	out.push(await measureAsync("ingestFileMmap  [mmap]", N, () => bf.ingestFileMmap(path).then(() => undefined), { group: "ingest", setup: reset }));
	out.push(await measureAsync("createIngestStream [pipe]", N, async () => {
		await pipeline(createReadStream(path), bf.createIngestStream());
	}, { group: "ingest", setup: reset }));
	rmSync(path, { force: true });
	return out;
}

// ---- data-dependence probe: classic query early-out ------------------------
// The classic kernel's k-probe loop has a data-dependent early-out, so query
// throughput depends on the hit ratio. Measure present vs absent on the
// zero-copy hasHashes path, where no string cost masks the branch, and report
// the gap instead of quoting one hit-ratio-specific number.

function dataDependence(): { present: Measurement; absent: Measurement } {
	// Use the zero-copy hasHashes path on a *classic* filter: with no per-element
	// V8 string cost to swamp it, the k-probe early-out is the only variable, so
	// any present-vs-absent gap is attributable to the branch and nothing else.
	const bf = newFilter("balanced");
	bf.addHashes(hashes);
	const absentHashes = new BigUint64Array(N);
	for (let i = 0; i < N; i++) absentHashes[i] = BigInt(i) * 0xd1b54a32d192ed03n + 0x9e3779b1n;
	return {
		present: measure("classic hasHashes [100% present]", N, () => bf.hasHashes(hashes), { group: "datadep" }),
		absent: measure("classic hasHashes [100% absent]", N, () => bf.hasHashes(absentHashes), { group: "datadep" }),
	};
}

// ---- reporting --------------------------------------------------------------

function ratio(num: Measurement, den: Measurement): string {
	const r = num.medianTput / den.medianTput;
	const overlap = ciOverlap(num.ci, den.ci);
	return `${r.toFixed(2)}×${overlap ? " (CIs overlap, not distinguishable)" : ""}`;
}

function byLabel(ms: Measurement[], needle: string): Measurement {
	const m = ms.find((x) => x.label.startsWith(needle));
	if (!m) throw new Error(`missing measurement: ${needle}`);
	return m;
}

function report(decomp: Measurement[], kern: Measurement[], ing: Measurement[], fp: FpResult[], dd: { present: Measurement; absent: Measurement }): void {
	console.log("Boundary-cost decomposition (each ratio changes exactly one variable)");
	for (const m of decomp) printRow(m);
	const setRef = byLabel(decomp, "Set.add");
	const loop = byLabel(decomp, "add() loop");
	const all = byLabel(decomp, "addAll");
	const intsM = byLabel(decomp, "addInts");
	const hashM = byLabel(decomp, "addHashes");
	console.log("\n  fair, same-work ratios:");
	console.log(`    crossing amortisation   addAll / add-loop  = ${ratio(all, loop)}   (N→1 crossings, identical per-key work)`);
	console.log(`    string-extraction cost  addInts / addAll   = ${ratio(intsM, all)}   (typed array vs V8 string bytes)`);
	console.log(`    native-hashing cost     addHashes / addInts = ${ratio(hashM, intsM)}  (pre-hashed digests skip hashing)`);
	console.log("\n  the one honest cross-workload point:");
	console.log(`    naive native add-loop (${fmtTput(loop.medianTput)}) vs JS Set (${fmtTput(setRef.medianTput)}): ratio ${ratio(loop, setRef)}.`);
	console.log(`    Per-key FFI crossings make the naive native path lose to a managed Set. That is the case for the tiered API, not a "${ratio(hashM, setRef)} faster than Set" headline (different work).`);

	console.log("\nKernel-path throughput (current kernel)");
	for (const m of kern) printRow(m);

	console.log("\nIngestion paths");
	for (const m of ing) printRow(m);

	console.log("\nData-dependence probe (why a single query number can mislead)");
	printRow(dd.present);
	printRow(dd.absent);
	console.log(`    classic query throughput is hit-ratio dependent: absent/present = ${ratio(dd.absent, dd.present)}.`);
	console.log(`    Note the direction is counter-intuitive: absent keys hit the k-probe early-out, yet run slower, because the early-out branch is data-dependent and mispredicts, which costs more than the bit-checks it skips. The default SBBF kernel has no such branch (testc is branchless), so it is hit-ratio independent. Either way, a lone query number is meaningless without stating the hit ratio.`);

	console.log();
	printFp(fp);
	console.log();
}

// ---- kernel comparison via pinned child processes ---------------------------
// THOTH_FORCE_KERNEL is read once at addon load, so scalar vs AVX2 cannot be
// switched in-process. We re-exec ourselves twice with the kernel pinned and
// compare the two independent runs (the statistically clean way to do it).

interface ChildPayload {
	kernel: string;
	measurements: Measurement[];
}

function runChild(forceKernel: string): ChildPayload | null {
	const res = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", SELF], {
		env: { ...process.env, THOTH_FORCE_KERNEL: forceKernel, BENCH_CHILD: "1" },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.status !== 0) {
		console.error(res.stderr);
		return null;
	}
	const line = res.stdout.split("\n").find((l) => l.startsWith("__BENCH_JSON__"));
	if (!line) return null;
	return JSON.parse(line.slice("__BENCH_JSON__".length)) as ChildPayload;
}

function compareKernels(): void {
	const env = captureEnv();
	printEnv(env, `comparison (N=${fmtTput(N).replace("ops/s", "")}, reps from BENCH_REPS)`);
	const scalar = runChild("scalar");
	const avx2 = runChild("avx2");
	if (!scalar || !avx2) {
		console.error("kernel comparison failed (a child did not emit results).");
		process.exit(1);
	}
	if (avx2.kernel !== "avx2") {
		console.log(`This CPU has no AVX2 path (forced-avx2 loaded "${avx2.kernel}"); nothing to compare. Scalar numbers only:\n`);
		for (const m of scalar.measurements) printRow(m);
		return;
	}
	console.log("AVX2 speedup over scalar (median throughput; >1 means AVX2 wins)\n");
	console.log("  workload                               scalar        avx2          speedup");
	const byLbl = (p: ChildPayload, l: string): Measurement => p.measurements.find((m) => m.label === l)!;
	for (const s of scalar.measurements) {
		const a = byLbl(avx2, s.label);
		const overlap = ciOverlap(s.ci, a.ci);
		const sp = a.medianTput / s.medianTput;
		console.log(
			`  ${s.label.padEnd(36)} ${fmtTput(s.medianTput).padStart(8)}     ${fmtTput(a.medianTput).padStart(8)}     ` +
			`${sp.toFixed(2)}×${overlap ? "  (CIs overlap)" : ""}`,
		);
	}
	console.log("\n  Control check: the classic kernel is scalar-only, so its row should sit at ~1.00×.");
	console.log("  A speedup there would mean the harness is measuring noise, not SIMD.");
	console.log();
}

// ---- entry points -----------------------------------------------------------

async function main(): Promise<void> {
	// Child mode: emit only the kernel-sensitive measurements as one JSON line.
	if (process.env.BENCH_CHILD === "1") {
		const payload: ChildPayload = { kernel: kernelName, measurements: kernelSensitive() };
		process.stdout.write("__BENCH_JSON__" + JSON.stringify(payload, (k, v) => (k === "throughput" ? undefined : v)) + "\n");
		return;
	}
	if (process.env.BENCH_COMPARE === "1") {
		compareKernels();
		return;
	}
	const env = captureEnv();
	console.log(`\nthothfilter benchmark (kernel=${kernelName}, N=${fmtTput(N).replace(/ ops\/s/, "")}, reps=${process.env.BENCH_REPS ?? 30})\n`);
	printEnv(env, kernelName);
	const decomp = decomposition();
	const kern = kernelSensitive();
	const ing = await ingestion();
	const dd = dataDependence();
	const fp = fpStudy(FP_SEEDS);
	report(decomp, kern, ing, fp, dd);
	writeResults(env, [...decomp, ...kern, ...ing, dd.present, dd.absent], fp);
}

/** Persist the full run (JSON with per-rep arrays) and a summary CSV. */
function writeResults(env: BenchEnv, measurements: Measurement[], fp: FpResult[]): void {
	const stamp = env.date.replace(/[:.]/g, "-");
	const base = join("bench", "results", `full-${kernelName}-${stamp}`);
	writeFile(`${base}.json`, JSON.stringify({ env, kernel: kernelName, n: N, measurements, fp }, null, 2) + "\n");
	writeFile(`${base}.csv`, measurementsToCsv(measurements));
	console.log(`results written: ${base}.json / .csv\n`);
}

await main();
