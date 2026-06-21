> tsc

(node:26545) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

thothfilter benchmark (kernel=avx2, N=1.0M, reps=30)

Environment
  date           2026-06-21T04:30:35.460Z
  cpu            Intel(R) Core(TM) i5-4210U CPU @ 1.70GHz (4 threads @ 2394 MHz)
  memory         7.2 GiB
  os             linux 7.0.12-arch1-1 (x64)
  runtime        node 22.17.0 / v8 12.4.254.21-node.26
  kernel loaded  avx2
  governor       schedutil   turbo-disabled=no   gc-exposed=yes
  commit         74144e6

  caveats affecting variance:
    - governor is "schedutil", not "performance": clocks may scale mid-run and widen the CIs.
    - turbo is enabled: opportunistic boosting adds throughput variance. Pin it off for tighter intervals.

Boundary-cost decomposition (each ratio changes exactly one variable)
  Set.add() loop          [JS baseline]    4.3M ops/s   95% CI      [4.3M, 4.3M]     best 4.4M   ±1.2%
  add() loop      [N crossings]           3.0M ops/s   95% CI      [2.9M, 3.0M]     best 3.0M   ±0.6%
  addAll(string[]) [1 crossing]           4.8M ops/s   95% CI      [4.2M, 4.8M]     best 4.8M   ±0.4%
  addInts(Uint32)  [1 crossing, zero-copy]   54.1M ops/s   95% CI    [53.9M, 54.3M]    best 55.3M   ±0.9%
  addHashes(u64)   [1 crossing, no hash]   62.3M ops/s   95% CI    [62.2M, 62.4M]    best 63.0M   ±0.3%

  fair, same-work ratios:
    crossing amortisation   addAll / add-loop  = 1.61×   (N→1 crossings, identical per-key work)
    string-extraction cost  addInts / addAll   = 11.34×   (typed array vs V8 string bytes)
    native-hashing cost     addHashes / addInts = 1.15×  (pre-hashed digests skip hashing)

  the one honest cross-workload point:
    naive native add-loop (3.0M) vs JS Set (4.3M): ratio 0.69×.
    Per-key FFI crossings make the naive native path lose to a managed Set. That is the case for the tiered API, not a "14.59× faster than Set" headline (different work).

Kernel-path throughput (current kernel)
  addHashes  [SBBF, memory-bound]        62.3M ops/s   95% CI    [62.2M, 62.4M]    best 62.8M   ±0.4%
  hasHashes  [SBBF, memory-bound]        69.1M ops/s   95% CI    [69.1M, 69.3M]    best 69.6M   ±0.3%
  addInts    [SBBF, +native hash]        53.9M ops/s   95% CI    [53.8M, 54.1M]    best 54.8M   ±0.6%
  addHashes  [classic, control]          29.8M ops/s   95% CI    [29.7M, 29.8M]    best 29.9M   ±0.2%
  unionInPlace [OR words]                1.03B ops/s   95% CI    [1.00B, 1.06B]    best 1.09B   ±5.4%

Ingestion paths
  ingestFile      [sync fread]           34.7M ops/s   95% CI    [34.6M, 34.8M]    best 35.1M   ±0.5%
  ingestFileAsync [libuv worker]         33.0M ops/s   95% CI    [32.7M, 33.5M]    best 34.6M   ±3.1%
  ingestFileMmap  [mmap]                 32.0M ops/s   95% CI    [31.8M, 32.4M]    best 33.3M   ±2.9%
  createIngestStream [pipe]              23.4M ops/s   95% CI    [22.9M, 24.0M]    best 25.9M   ±5.8%

Data-dependence probe (why a single query number can mislead)
  classic hasHashes [100% present]       31.3M ops/s   95% CI    [31.3M, 31.4M]    best 31.4M   ±0.2%
  classic hasHashes [100% absent]        26.3M ops/s   95% CI    [26.3M, 26.3M]    best 26.4M   ±0.1%
    classic query throughput is hit-ratio dependent: absent/present = 0.84×.
    Note the direction is counter-intuitive: absent keys hit the k-probe early-out, yet run slower, because the early-out branch is data-dependent and mispredicts, which costs more than the bit-checks it skips. The default SBBF kernel has no such branch (testc is branchless), so it is hit-ratio independent. Either way, a lone query number is meaningless without stating the hit ratio.

False-positive accuracy (model vs delivered, sampled over seeds)
  profile     mode      bits/key   model FP    delivered FP (95% CI)        verdict        1-trial SD
  speed      fast       10.53   0.0100     0.0100 [0.0099, 0.0101]   matches        ±0.0002
  balanced   classic     9.97   0.0100     0.0100 [0.0099, 0.0101]   matches        ±0.0002
  memory     classic     9.97   0.0100     0.0100 [0.0099, 0.0101]   matches        ±0.0002
  (24 seeds, 200,000 keys / 200,000 probes each. "matches" = the model prediction lands inside the delivered CI.)

results written: bench/results/full-avx2-2026-06-21T04-30-35-460Z.json / .csv