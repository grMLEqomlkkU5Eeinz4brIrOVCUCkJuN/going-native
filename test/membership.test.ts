import { BloomFilter, kernelName } from "../dist/index.js";
import type { ProfileName } from "../dist/index.js";

describe("membership & false-positive behaviour", () => {
	test("no false negatives for inserted keys (the hard invariant)", () => {
		const bf = new BloomFilter({ n: 20000, fpRate: 0.01 });
		const keys = Array.from({ length: 20000 }, (_, i) => `key-${i}`);
		bf.addAll(keys);
		for (const k of keys) expect(bf.has(k)).toBe(true);
	});

	test("agrees with a JS Set on membership (no false negatives, bounded FP)", () => {
		const set = new Set<string>();
		const bf = new BloomFilter({ n: 50000, fpRate: 0.01 });
		for (let i = 0; i < 50000; i++) {
			const k = `member-${i}`;
			set.add(k);
			bf.add(k);
		}
		// every Set member is present in the filter
		for (const k of set) expect(bf.has(k)).toBe(true);
		// false-positive rate on absent keys stays near target
		let fp = 0;
		const trials = 50000;
		for (let i = 0; i < trials; i++) if (bf.has(`absent-${i}`)) fp++;
		expect(fp / trials).toBeLessThan(0.02); // < 2x the 1% target
	});

	const profiles: ProfileName[] = ["speed", "balanced", "memory", "concurrent"];
	test.each(profiles)("profile %s hits its target FP rate", (profile) => {
		const n = 40000;
		const bf = new BloomFilter({ profile, n, fpRate: 0.01 });
		for (let i = 0; i < n; i++) bf.add(`k${i}`);
		for (let i = 0; i < n; i++) expect(bf.has(`k${i}`)).toBe(true);
		let fp = 0;
		for (let i = 0; i < n; i++) if (bf.has(`z${i}`)) fp++;
		expect(fp / n).toBeLessThan(0.025);
	});

	test("classic mode supports a freely chosen k", () => {
		const bf = new BloomFilter({ mode: "classic", k: 11, n: 30000, fpRate: 0.005 });
		expect(bf.config.k).toBe(11);
		for (let i = 0; i < 30000; i++) bf.add(`c${i}`);
		for (let i = 0; i < 30000; i++) expect(bf.has(`c${i}`)).toBe(true);
	});

	test("Tier-0 hashes & ints round-trip without false negatives", () => {
		const bf = new BloomFilter({ m: 1 << 18, seed: 7n });
		const hashes = new BigUint64Array(5000);
		for (let i = 0; i < hashes.length; i++) hashes[i] = BigInt(i) * 0x9e3779b97f4a7c15n;
		bf.addHashes(hashes);
		const present = bf.hasHashes(hashes);
		expect(Array.from(present).every((x) => x === 1)).toBe(true);

		const ints = new Uint32Array([1, 2, 3, 1000000, 4294967295]);
		bf.addInts(ints);
		expect(Array.from(bf.hasInts(ints)).every((x) => x === 1)).toBe(true);
	});

	test("addDelimited parses a buffer natively (Tier 1)", () => {
		const bf = new BloomFilter({ m: 1 << 16, seed: 1n });
		const count = bf.addDelimited(Buffer.from("alpha\nbeta\ngamma\n"), "\n");
		expect(count).toBe(3);
		expect(bf.has("alpha")).toBe(true);
		expect(bf.has("beta")).toBe(true);
		expect(bf.has("delta")).toBe(false);
	});

	test("reports which kernel runtime dispatch selected", () => {
		expect(["avx2", "scalar"]).toContain(kernelName);
	});
});
