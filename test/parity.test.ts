import { execFileSync } from "node:child_process";
import { kernelName } from "../dist/index.js";

// Cross-kernel bit-exactness: the scalar and AVX2 kernels MUST produce
// bit-identical tables for the same keys + seed, or a save/load across a kernel
// boundary yields silent false negatives. We build the same filter in two child
// processes with the kernel pinned via THOTH_FORCE_KERNEL and compare bytes.
// JSON.stringify can't serialize BigInt seeds, so emit a JS object literal where
// bigints keep their `n` suffix.
function toSource(obj: Record<string, unknown>): string {
	const parts = Object.entries(obj).map(([key, value]) => {
		const v = typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
		return `${JSON.stringify(key)}: ${v}`;
	});
	return `{ ${parts.join(", ")} }`;
}

interface BuiltTable {
	name: string;
	bytes: Buffer;
}

function buildTable(kernel: string, opts: Record<string, unknown>): BuiltTable {
	const script = `
		import { BloomFilter, kernelName } from "./dist/index.js";
		const bf = new BloomFilter(${toSource(opts)});
		const keys = Array.from({ length: 5000 }, (_, i) => "golden-" + i);
		bf.addAll(keys);
		process.stdout.write(kernelName + "|" + Buffer.from(bf.tableBytes).toString("base64"));
	`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, THOTH_FORCE_KERNEL: kernel },
		encoding: "utf8",
	});
	const [name, b64] = out.split("|");
	return { name, bytes: Buffer.from(b64, "base64") };
}

describe("cross-kernel golden-vector parity", () => {
	// seed must be fixed so the mapping is identical across runs.
	const cases: [string, Record<string, unknown>][] = [
		["fast-256", { profile: "speed", m: 1 << 17, seed: 99n }],
		["fast-512", { profile: "speed", blockBits: 512, k: 16, m: 1 << 17, seed: 99n }],
	];
	test.each(cases)("scalar == avx2 for %s", (_name, opts) => {
		const scalar = buildTable("scalar", opts);
		const avx2 = buildTable("avx2", opts);
		expect(scalar.name).toBe("scalar");
		expect(scalar.bytes.equals(avx2.bytes)).toBe(true);
		if (avx2.name !== "avx2") {
			// AVX2 not available on this host; parity is trivially the scalar path.
			console.warn("AVX2 kernel unavailable; parity test ran scalar-vs-scalar");
		}
	});

	test("the active kernel reproduces the golden table", () => {
		const active = buildTable(kernelName, { profile: "speed", m: 1 << 17, seed: 99n });
		const scalar = buildTable("scalar", { profile: "speed", m: 1 << 17, seed: 99n });
		expect(active.bytes.equals(scalar.bytes)).toBe(true);
	});
});
