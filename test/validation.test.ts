import { BloomFilter, BloomConfigError } from "../dist/index.js";
import type { BloomOptions } from "../dist/index.js";

// Some cases pass deliberately invalid knobs (e.g. blockBits:128) that the
// public types forbid; route them through this loosely-typed helper so the
// runtime validation (not the compiler) is what we exercise.
const bad = (opts: unknown): BloomFilter => new BloomFilter(opts as BloomOptions);

// error messages must teach the fix. Each test asserts the message names a
// concrete option to change, not just that it throws.
describe("config validation messages", () => {
	test("fast + arbitrary k points to mode:classic", () => {
		expect(() => new BloomFilter({ k: 10, n: 1000, fpRate: 0.01 })).toThrow(BloomConfigError);
		try {
			new BloomFilter({ k: 10, n: 1000, fpRate: 0.01 });
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toMatch(/fast mode/);
			expect(msg).toContain('mode: "classic"');
			expect(msg).toContain("k: 10"); // copy-pasteable fix
		}
	});

	test("fast + blockBits:512 + k:8 says k must be 16", () => {
		try {
			new BloomFilter({ mode: "fast", blockBits: 512, k: 8, n: 1000, fpRate: 0.01 });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(BloomConfigError);
			const msg = (e as Error).message;
			expect(msg).toMatch(/blockBits=512 requires k=16/);
			expect(msg).toMatch(/k=8 was given/);
		}
	});

	test("concurrent profile + shared:false explains the contradiction", () => {
		try {
			new BloomFilter({ profile: "concurrent", shared: false, n: 1000, fpRate: 0.01 });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(BloomConfigError);
			const msg = (e as Error).message;
			expect(msg).toContain('"concurrent" profile');
			expect(msg).toContain("shared:false");
		}
	});

	test("classic k out of 1..64 range is rejected", () => {
		expect(() => new BloomFilter({ mode: "classic", k: 100, n: 1000, fpRate: 0.01 })).toThrow(/1\.\.64/);
		expect(() => new BloomFilter({ mode: "classic", k: 0, n: 1000, fpRate: 0.01 })).toThrow(/1\.\.64/);
	});

	test("blockBits other than 256/512 is rejected", () => {
		expect(() => bad({ blockBits: 128, n: 1000, fpRate: 0.01 })).toThrow(/256 or 512/);
	});

	test("sizing under-specified is a teaching error", () => {
		expect(() => new BloomFilter({})).toThrow(/table size is unspecified/);
	});

	test("sizing over-specified is rejected", () => {
		expect(() => new BloomFilter({ n: 1000, fpRate: 0.01, m: 4096 })).toThrow(/over-specified/);
	});

	test("bitsPerKey without n is a teaching error", () => {
		expect(() => new BloomFilter({ bitsPerKey: 10 })).toThrow(/needs an expected key count/);
	});

	test("fpRate out of range is rejected", () => {
		expect(() => new BloomFilter({ n: 1000, fpRate: 1.5 })).toThrow(/out of range/);
	});

	test("non-rapidhash (secure/xxh3) is reported as not yet available", () => {
		expect(() => new BloomFilter({ profile: "secure", n: 1000, fpRate: 0.01 })).toThrow(/not yet available/);
	});
});
