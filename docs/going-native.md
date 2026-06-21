# Is it worth going native? And can you push it parallel?

A decision aid distilled from the measurements in this repo. Every branch is
backed by a number from the benchmark, listed in the legend below.

```mermaid
flowchart TD
    A["Hot operation in JS"] --> B{"Can you batch it into one native call?"}
    B -- "No, it must run per element" --> JS1["Stay in JS.<br/>The per-call crossing tax dominates."]
    B -- "Yes" --> C{"Can the data cross zero-copy?<br/>(typed arrays, buffers, pre-hashed)"}

    C -- "No, each element is marshalled<br/>(e.g. V8 strings)" --> D{"Is the per-element<br/>compute heavy?"}
    D -- "No" --> JS2["Stay in JS.<br/>Marshalling cost outweighs the win."]
    D -- "Yes" --> E{"Compute-bound or memory-bound?"}
    C -- "Yes" --> E

    E -- "Compute-bound,<br/>working set fits in cache" --> N1["Go native WITH SIMD"]
    E -- "Memory-bound,<br/>random access over more than cache" --> N2["Go native, skip SIMD.<br/>Batch + prefetch.<br/>Throughput capped by the memory wall."]

    N1 --> P{"Big enough to amortize<br/>thread setup?"}
    N2 --> P
    P -- "No" --> S["Single thread"]
    P -- "Yes" --> P2{"Is the work independent?<br/>(e.g. a commutative reduction)"}
    P2 -- "No" --> S
    P2 -- "Yes" --> P3{"Compute-bound or<br/>memory-bandwidth-bound?"}
    P3 -- "Compute-bound" --> PAR1["Parallelize.<br/>Scales with cores."]
    P3 -- "Memory-bandwidth-bound" --> PAR2["Parallelize with caution.<br/>Gains stop once memory bandwidth saturates."]
```

## Why each branch (the evidence)

- **Batch or stay home.** A native `add()` called once per element ran at 3.0M
  ops/s and *lost* to a plain JS `Set` at 4.3M. Batching the same work into one
  call (`addAll`) reached 4.8M. If you cannot collapse the per-element crossings,
  native is not worth it.
- **Zero-copy is where native pays.** Handing data across as a typed array or
  pre-hashed buffer (`addInts`, `addHashes`) hit 54M to 69M ops/s, roughly 14x
  the per-element path. The dominant boundary cost was not the crossing itself
  (about 1.6x) but extracting each element from a V8 string (about 11x). If your
  elements must be marshalled one by one, most of the native win is eaten before
  the kernel runs.
- **SIMD does not beat the memory wall.** For random access over a table larger
  than cache, throughput fell from about 132M ops/s (table in L2) to about 50M
  (table in RAM), and the AVX2 kernel was statistically indistinguishable from
  the scalar one. SIMD speeds up arithmetic, not waiting on memory. Native still
  helps here, through batching and prefetch, but reach for SIMD only when the
  work is compute-bound and fits in cache.
- **Parallel needs independent work and enough of it.** This filter parallelizes
  because its insert is a bitwise OR, which is commutative and associative, so
  shards merge without coordination. Two conditions still gate it: the job must
  be large enough to pay back thread setup, and if the kernel is memory-bound
  the speedup tapers once the cores saturate memory bandwidth rather than
  compute. Parallelism multiplies a compute bound; it cannot multiply a
  bandwidth bound.

## One-line summary

Go native when you can **batch** and hand data over **zero-copy**. Add **SIMD**
only when the work is **compute-bound and cache-resident**. Go **parallel** only
when the work is **independent, large, and not already bandwidth-bound**.
