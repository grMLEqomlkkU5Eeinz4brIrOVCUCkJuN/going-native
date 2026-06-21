# thothfilter

A speed-first **native Bloom filter** for Node.js. Two kernels behind one
configurable surface: a split-block Bloom filter (SBBF) for raw throughput, and a
cache-blocked classic filter for a freely chosen `k`. SIMD (AVX2) where present,
scalar everywhere, with **bit-identical results across kernels**.

The organizing principle: **the JS/native boundary is the bottleneck, and random
memory access is the second.** The API is shaped so the hot path crosses the
boundary as few times as possible and touches as few cache lines per key as
possible.

> Parallel ingest, `SharedArrayBuffer` backing, and the `secure` (SipHash) profile are scoped for
> later phases.

> I apologize AOT if you do find the content here lacking. This is because the original
> version of this project was an academic submission. What you are looking at is an
> approved stripped down version of this project.

## Build / test / bench

```bash
npm install      # install deps
npm run build    # build the native addon (node-gyp) and compile TypeScript to dist/
npm test         # build, then run the Jest suite
npm run bench    # build, then run the benchmark harness
```

The default build needs nothing but a C/C++ toolchain: the hash (`rapidhash`)
is vendored, not packaged (no Conan on the default path). The native layer is C++
throughout (kernels, CPU dispatch, and the node-addon-api wrapper).

## Quick start

```ts
import { BloomFilter } from "thothfilter";

// pick a profile, override any knob
const bf = new BloomFilter({ n: 1_000_000, fpRate: 0.01 }); // default: speed/SBBF

bf.add("hello");
bf.has("hello"); // true
bf.has("world"); // false (with ~1% false-positive rate)
```

## Configuration: profile + knobs

Construction is two layers: a named **profile** (curated defaults) and explicit
**knobs** that override individual fields. Knob always wins.

| Profile        | mode    | k          | blockBits | hash      | for                              |
| -------------- | ------- | ---------- | --------- | --------- | -------------------------------- |
| `speed` *(default)* | fast | 8       | 256       | rapidhash | max single-machine throughput    |
| `balanced`     | classic | from fpRate| 512       | rapidhash | good speed *and* accuracy         |
| `memory`       | classic | optimal    | 512       | rapidhash | minimum bits per key              |
| `concurrent`   | fast    | 16         | 512       | rapidhash | many threads writing one filter   |
| `secure`       | fast    | 8          | 256       | siphash   | adversarial keys *(later phase)*  |

```ts
new BloomFilter({ profile: "memory", n: 1e6, fpRate: 0.001 });
new BloomFilter({ mode: "classic", k: 10, n: 1e6, fpRate: 0.01 }); // free k
new BloomFilter({ m: 1 << 20, seed: 42n });                        // reproducible
```

`fast` mode locks `k` to the block geometry (8 or 16). Asking for any other `k`
in `fast` is a hard error that points you to `mode:"classic"`. The message
teaches the fix:

```text
BloomFilter: k=10 is not valid in fast mode: fast sets k by block geometry
(k=8 for blockBits=256, k=16 for blockBits=512). To use k=10, pass
mode:"classic" (free k, 1..64): new BloomFilter({ mode: "classic", k: 10 }).
Or keep fast and drop k to accept the default 8.
```

## The marshalling-tier API

Shaped around how much boundary cost each call pays, fastest first.

```ts
// Tier 0: zero marshalling (the throughput ceiling)
bf.addHashes(BigUint64Array);  bf.hasHashes(BigUint64Array): Uint8Array
bf.addInts(Uint32Array | BigUint64Array);  bf.hasInts(...): Uint8Array

// Tier 1: one bulk buffer, native parsing
bf.addDelimited(buffer, "\n");

// Tier 1/0: file & stream ingestion (native read + split)
bf.ingestFile(path, { delimiter: "\n" });             // sync fread loop
await bf.ingestFileAsync(path);                       // libuv worker, off the event loop
await bf.ingestFileMmap(path);                        // mmap whole file (buffered fallback on Windows)
import { pipeline } from "node:stream/promises";
await pipeline(fs.createReadStream(path), bf.createIngestStream()); // no JS-side parsing

// Tier 2: one crossing, per-element extract
bf.addAll(["a", "b"]);  bf.hasAll([...]): Uint8Array

// Tier 3: single op (convenience)
bf.add(key);  bf.has(key): boolean
```

## Persistence & set ops

```ts
const buf = bf.toBuffer();             // full-geometry header ++ table bytes
const reloaded = BloomFilter.fromBuffer(buf);

BloomFilter.union(a, b);               // SIMD OR  (same geometry + seed required)
BloomFilter.intersect(a, b);           // SIMD AND
```

Reload and set ops require an identical `(mode, m, k, blockBits, hash, seed)`;
the header records all of it. Combine filters by giving them the same `seed`.

## How it works (short version)

- **`fast` (SBBF):** one key sets exactly one bit per 32-bit lane in a single
  256/512-bit block chosen by Lemire multiply-shift. Insert is one SIMD `OR`;
  query is one `AND`-compare. ~30-40% more bits than classic for the same FP, in
  exchange for collapsing each op to one cache line.
- **`classic`:** cache-blocked filter with a scalar k-probe loop, free `k` in
  1..64. Fewer bits per key at a given FP.
- **Kernels:** scalar reference + AVX2, selected at load by CPU detection, are
  **bit-identical** (a golden-vector parity test enforces it). A filter saved on
  one machine queries correctly on another.
- **Hashing:** `rapidhash` (vendored, seedable). The seed is per-instance random
  by default; pass an explicit `seed` for reproducibility.

## Developer experience

This template ships with the tooling to run it like a real published native
addon:

- **Linting:** flat ESLint config built on `@eslint/js` and
  `typescript-eslint` recommended sets, plus the project rules (tabs, double
  quotes). `npm run lint` / `npm run lint:fix`.
- **C++ formatting:** `clang-format` (config in `.clang-format`) via
  `npm run format`, enforced on commit and checked in CI.
- **API docs:** [TypeDoc](https://typedoc.org) renders an HTML API reference
  from the TSDoc comments (and the hand-written guides in `docs/`) into
  `docs/api/` (`npm run docs`).
- **Conventional Commits:** `commitlint` enforces the
  [Conventional Commits](https://www.conventionalcommits.org) format, and
  [git-cliff](https://git-cliff.org) turns that history into `CHANGELOG.md`
  (`npm run changelog`).
- **Git hooks:** [lefthook](https://lefthook.dev) runs ESLint on staged
  JS/TS and `clang-format` on staged C/C++ before each commit, then lints the
  commit message. Installed automatically by the `prepare` script on
  `npm install` (inside a git repo).
- **CI:** `.github/workflows/ci.yml` builds the native addon + TypeScript,
  lints, type-checks, and tests across Linux/macOS/Windows on Node 22 & 24,
  checks C++ formatting, builds the docs, and uploads the build artifact.
- **Editor config:** `.vscode/` recommends ESLint, Todo Tree, clangd and
  clang-format extensions, and wires up format-on-save via ESLint.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Build the native addon (`node-gyp`) and compile TypeScript. |
| `npm run build:debug` | Build the native addon with debug symbols. |
| `npm run clean` | Remove native build output and `dist/`. |
| `npm run dev` | Build, then run with nodemon. |
| `npm test` | Build, then run the Jest suite (TypeScript tests via ts-jest). |
| `npm run typecheck` | Type-check the library (`lib/`) without emitting. |
| `npm run typecheck:test` | Type-check the TypeScript tests + benchmark. |
| `npm run bench` | Build, then run the benchmark harness (TypeScript). |
| `npm run lint` / `lint:fix` | Run ESLint (optionally auto-fixing). |
| `npm run format` | Format C/C++ sources with clang-format. |
| `npm run docs` | Generate the HTML API reference into `docs/api/`. |
| `npm run changelog` | Regenerate `CHANGELOG.md` from the commit history. |

### Releasing

`./release.sh v[X.Y.Z]` bumps the version in `package.json`, regenerates
`CHANGELOG.md`, commits, and creates an annotated tag. Then
`git push && git push --tags`.

Only `dist/`, `build/Release`, `src/` and `binding.gyp` are published (the
`"files"` allowlist in `package.json`).

