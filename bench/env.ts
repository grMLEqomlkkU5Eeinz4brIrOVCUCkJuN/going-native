/*
 * Capture the execution context a reader needs to judge (and reproduce) a
 * benchmark number: hardware, runtime versions, the SIMD kernel that was
 * actually loaded, and the machine-state knobs (CPU governor, turbo) that
 * dominate run-to-run variance. The harness prints this block above every run
 * and embeds it in the JSON sidecar, so no number is ever quoted context-free.
 */
import { cpus, totalmem, arch, platform, release as osRelease } from "node:os";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface BenchEnv {
	date: string;
	node: string;
	v8: string;
	platform: string;
	arch: string;
	osRelease: string;
	cpuModel: string;
	cpuCount: number;
	cpuMHz: number;
	totalMemGiB: number;
	/** Linux CPU frequency governor, e.g. "performance" | "powersave". */
	governor: string | null;
	/** true if intel_pstate turbo is disabled (lower variance). */
	turboDisabled: boolean | null;
	/** Whether --expose-gc was passed (the harness GCs between reps when so). */
	gcExposed: boolean;
	gitCommit: string | null;
	gitDirty: boolean | null;
}

function tryRead(path: string): string | null {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

function git(args: string): string | null {
	try {
		return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return null;
	}
}

export function captureEnv(): BenchEnv {
	const c = cpus();
	const noTurbo = tryRead("/sys/devices/system/cpu/intel_pstate/no_turbo");
	const dirty = git("status --porcelain");
	return {
		date: new Date().toISOString(),
		node: process.versions.node,
		v8: process.versions.v8,
		platform: platform(),
		arch: arch(),
		osRelease: osRelease(),
		cpuModel: c[0]?.model.trim() ?? "unknown",
		cpuCount: c.length,
		cpuMHz: c[0]?.speed ?? 0,
		totalMemGiB: totalmem() / 2 ** 30,
		governor: tryRead("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
		turboDisabled: noTurbo === null ? null : noTurbo === "1",
		gcExposed: typeof (globalThis as { gc?: unknown }).gc === "function",
		gitCommit: git("rev-parse --short HEAD"),
		gitDirty: dirty === null ? null : dirty.length > 0,
	};
}

/** Print the context block, then any caveats that would inflate variance. */
export function printEnv(env: BenchEnv, kernel: string): void {
	const yn = (b: boolean | null): string => (b === null ? "?" : b ? "yes" : "no");
	console.log("Environment");
	console.log(`  date           ${env.date}`);
	console.log(`  cpu            ${env.cpuModel} (${env.cpuCount} threads @ ${env.cpuMHz} MHz)`);
	console.log(`  memory         ${env.totalMemGiB.toFixed(1)} GiB`);
	console.log(`  os             ${env.platform} ${env.osRelease} (${env.arch})`);
	console.log(`  runtime        node ${env.node} / v8 ${env.v8}`);
	console.log(`  kernel loaded  ${kernel}`);
	console.log(`  governor       ${env.governor ?? "?"}   turbo-disabled=${yn(env.turboDisabled)}   gc-exposed=${yn(env.gcExposed)}`);
	console.log(`  commit         ${env.gitCommit ?? "?"}${env.gitDirty ? " (working tree dirty)" : ""}`);

	const warn: string[] = [];
	if (!env.gcExposed) warn.push("run with --expose-gc so the harness can GC between reps (lower cross-rep contamination).");
	if (env.governor && env.governor !== "performance") warn.push(`governor is "${env.governor}", not "performance": clocks may scale mid-run and widen the CIs.`);
	if (env.turboDisabled === false) warn.push("turbo is enabled: opportunistic boosting adds throughput variance. Pin it off for tighter intervals.");
	if (env.gitDirty) warn.push("the working tree is dirty: this run is not attributable to a clean commit.");
	if (warn.length) {
		console.log("\n  caveats affecting variance:");
		for (const w of warn) console.log(`    - ${w}`);
	}
	console.log();
}
