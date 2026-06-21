import { BloomFilter } from "../dist/index.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A set of keys whose joined-with-"\n" length crosses the 64 KiB native
 * chunk boundary several times, so carry handling is actually exercised. */
function makeKeys(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `record-${i}-payload`);
}

async function withTempFile<T>(
	contents: string | Uint8Array,
	fn: (path: string) => T | Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "thoth-ingest-"));
	const path = join(dir, "data.txt");
	await writeFile(path, contents);
	try {
		return await fn(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function* chunkOddly(buf: Buffer, size: number): Generator<Buffer> {
	for (let i = 0; i < buf.length; i += size) {
		yield buf.subarray(i, Math.min(i + size, buf.length));
	}
}

describe("Phase 5: streaming & file ingestion", () => {
	test("ingestFile (sync) inserts every record with no false negatives", async () => {
		const keys = makeKeys(20000);
		await withTempFile(keys.join("\n") + "\n", (path) => {
			const bf = new BloomFilter({ n: 20000, fpRate: 0.01 });
			const count = bf.ingestFile(path);
			expect(count).toBe(keys.length);
			for (const k of keys) expect(bf.has(k)).toBe(true);
		});
	});

	test("a final record without a trailing delimiter is still inserted", async () => {
		await withTempFile("alpha\nbeta\ngamma", (path) => {
			const bf = new BloomFilter({ m: 1 << 16, seed: 1n });
			const count = bf.ingestFile(path);
			expect(count).toBe(3);
			expect(bf.has("gamma")).toBe(true);
		});
	});

	test("empty records (consecutive delimiters) are skipped", async () => {
		await withTempFile("a\n\n\nb\n", (path) => {
			const bf = new BloomFilter({ m: 1 << 16, seed: 2n });
			const count = bf.ingestFile(path);
			expect(count).toBe(2);
			expect(bf.has("a")).toBe(true);
			expect(bf.has("b")).toBe(true);
		});
	});

	test("ingestFileAsync resolves with the count and matches sync", async () => {
		const keys = makeKeys(30000);
		await withTempFile(keys.join("\n") + "\n", async (path) => {
			const bf = new BloomFilter({ n: 30000, fpRate: 0.01 });
			const count = await bf.ingestFileAsync(path);
			expect(count).toBe(keys.length);
			for (const k of keys) expect(bf.has(k)).toBe(true);
		});
	});

	test("ingestFileMmap produces an identical table to the buffered reader", async () => {
		const keys = makeKeys(30000);
		await withTempFile(keys.join("\n") + "\n", async (path) => {
			const a = new BloomFilter({ n: 30000, fpRate: 0.01, seed: 99n });
			const b = new BloomFilter({ n: 30000, fpRate: 0.01, seed: 99n });
			const ca = await a.ingestFileAsync(path);
			const cb = await b.ingestFileMmap(path);
			expect(cb).toBe(ca);
			// same keys, same seed, and same geometry produce bit-identical tables.
			expect(Buffer.from(b.tableBytes)).toEqual(Buffer.from(a.tableBytes));
		});
	});

	test("ingestFileAsync rejects on a missing file", async () => {
		const bf = new BloomFilter({ m: 1 << 16 });
		await expect(bf.ingestFileAsync("/no/such/path/xyz.txt")).rejects.toThrow(
			/cannot open file/,
		);
	});

	test("createIngestStream ingests a piped Readable with no JS parsing", async () => {
		const keys = makeKeys(25000);
		const bf = new BloomFilter({ n: 25000, fpRate: 0.01 });
		// feed odd-sized chunks so records straddle chunk boundaries
		const blob = Buffer.from(keys.join("\n") + "\n");
		const src = Readable.from(chunkOddly(blob, 1000));
		await pipeline(src, bf.createIngestStream());
		for (const k of keys) expect(bf.has(k)).toBe(true);
	});

	test("createIngestStream from a real file via pipeline", async () => {
		const keys = makeKeys(15000);
		await withTempFile(keys.join("\n") + "\n", async (path) => {
			const bf = new BloomFilter({ n: 15000, fpRate: 0.01 });
			await pipeline(createReadStream(path), bf.createIngestStream());
			for (const k of keys) expect(bf.has(k)).toBe(true);
		});
	});

	test("adversarial chunk boundaries: split a known input at every offset", async () => {
		// Reference: addDelimited on the whole buffer (one shot, no carry).
		const keys = ["foo", "barbaz", "q", "longer-key-here", "x"];
		const blob = Buffer.from(keys.join("\n") + "\n");
		const reference = new BloomFilter({ m: 1 << 16, seed: 5n });
		reference.addDelimited(blob, "\n");

		// Stream the same bytes split at each possible 2-chunk boundary; the
		// resulting table must be bit-identical regardless of where we cut.
		for (let cut = 0; cut <= blob.length; cut++) {
			const bf = new BloomFilter({ m: 1 << 16, seed: 5n });
			const src = Readable.from([blob.subarray(0, cut), blob.subarray(cut)]);
			await pipeline(src, bf.createIngestStream());
			expect(Buffer.from(bf.tableBytes)).toEqual(
				Buffer.from(reference.tableBytes),
			);
		}
	});
});
