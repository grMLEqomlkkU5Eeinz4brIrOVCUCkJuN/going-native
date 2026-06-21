import { BloomFilter } from "../dist/index.js";
import type { BloomOptions } from "../dist/index.js";

describe("serialization round-trip", () => {
	const cases: [string, BloomOptions][] = [
		["speed", { profile: "speed", n: 20000, fpRate: 0.01 }],
		["balanced", { profile: "balanced", n: 20000, fpRate: 0.01 }],
		["concurrent", { profile: "concurrent", n: 20000, fpRate: 0.01 }],
		["classic-k", { mode: "classic", k: 9, n: 20000, fpRate: 0.01 }],
	];
	test.each(cases)("%s survives toBuffer/fromBuffer bit-for-bit", (_name, opts) => {
		const bf = new BloomFilter(opts);
		const keys = Array.from({ length: 20000 }, (_, i) => `k-${i}`);
		bf.addAll(keys);

		const buf = bf.toBuffer();
		const loaded = BloomFilter.fromBuffer(buf);

		// geometry preserved
		expect(loaded.config.mode).toBe(bf.config.mode);
		expect(loaded.config.k).toBe(bf.config.k);
		expect(loaded.config.blockBits).toBe(bf.config.blockBits);
		expect(loaded.config.nblk).toBe(bf.config.nblk);
		expect(loaded.config.seed).toBe(bf.config.seed);

		// raw table bytes identical
		expect(Buffer.from(loaded.tableBytes)).toEqual(Buffer.from(bf.tableBytes));

		// membership preserved
		for (const k of keys.slice(0, 2000)) expect(loaded.has(k)).toBe(true);
	});

	test("fromBuffer rejects a non-thoth buffer", () => {
		expect(() => BloomFilter.fromBuffer(Buffer.from("not a filter"))).toThrow(/bad magic/);
	});

	test("clone produces an independent, equal filter", () => {
		const bf = new BloomFilter({ m: 1 << 16, seed: 3n });
		bf.addAll(["a", "b", "c"]);
		const c = bf.clone();
		c.add("d");
		expect(bf.has("d")).toBe(false); // independent
		expect(c.has("a")).toBe(true); // copied
	});
});

describe("set operations", () => {
	test("union is the bitwise OR of two same-geometry filters", () => {
		const a = new BloomFilter({ m: 1 << 16, seed: 5n });
		const b = new BloomFilter({ m: 1 << 16, seed: 5n });
		a.addAll(["x", "y"]);
		b.addAll(["y", "z"]);
		const u = BloomFilter.union(a, b);
		expect(u.has("x")).toBe(true);
		expect(u.has("y")).toBe(true);
		expect(u.has("z")).toBe(true);
	});

	test("intersect keeps only common bits", () => {
		const a = new BloomFilter({ m: 1 << 18, seed: 5n });
		const b = new BloomFilter({ m: 1 << 18, seed: 5n });
		a.addAll(["x", "y"]);
		b.addAll(["y", "z"]);
		const it = BloomFilter.intersect(a, b);
		expect(it.has("y")).toBe(true);
		// x and z were each only in one operand, so they should be absent (large m, no FP collision)
		expect(it.has("x")).toBe(false);
		expect(it.has("z")).toBe(false);
	});

	test("set ops on mismatched seed/geometry throw", () => {
		const a = new BloomFilter({ m: 1 << 16, seed: 1n });
		const b = new BloomFilter({ m: 1 << 16, seed: 2n });
		expect(() => BloomFilter.union(a, b)).toThrow(/identical geometry/);
	});
});
