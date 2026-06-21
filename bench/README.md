# Benchmarks

A step-by-step guide to running the thothfilter benchmarks and turning the
output into the numbers and figures the paper cites.

Every number is reported as a distribution (median + bootstrap 95% CI over many
reps), not a single timing. Each run prints its full environment (CPU, governor,
turbo, kernel, commit) and writes machine-readable results to `bench/results/`.

## 0. Prerequisites

- Node >= 22 (the harness runs TypeScript directly via `--experimental-strip-types`).
- A C/C++ toolchain (the native addon builds on first run).

Every `npm run bench*` script builds the addon and the TypeScript first, so you
do not need a separate build step.

## 1. Pin the machine (do this for the runs you cite)

A drifting clock turns a comparison into noise. Before the runs that produce
ratios (tier vs tier, scalar vs AVX2, the size sweep), pin the CPU:

```
! sudo cpupower frequency-set -g performance
! echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
```

The harness records the governor and turbo state in every run, so the report
tells you whether you remembered. To restore normal behaviour afterwards:

```
! sudo cpupower frequency-set -g schedutil
! echo 0 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
```

Also run one extra pass with turbo back ON for a realistic "as deployed"
throughput number, and label it as such. Pinned numbers are for comparisons,
not for claiming what users get.

## 2. The full suite

```
npm run bench
```

Reports, in order:

1. Boundary-cost decomposition: the corrected headline. Each ratio changes one
   variable (crossings, then string extraction, then native hashing).
2. Kernel-path throughput for the loaded kernel.
3. Ingestion paths (sync, libuv, mmap, stream).
4. Data-dependence probe (why a single query number can mislead).
5. False-positive accuracy (model vs delivered, sampled over seeds).

Writes `bench/results/full-<kernel>-<timestamp>.json` (full per-rep data) and a
summary `.csv`.

## 3. Scalar vs AVX2

```
npm run bench:compare
```

The kernel is chosen once at addon load, so this re-runs the kernel-sensitive
benches in two pinned child processes (`THOTH_FORCE_KERNEL=scalar` and `=avx2`)
and prints the speedup per workload, flagging any pair whose CIs overlap as not
distinguishable. The classic row is a control: it is scalar-only, so it should
sit at ~1.00x. A speedup there means the run is measuring noise.

If the CPU has no AVX2 path, the comparison says so and prints scalar only.

## 4. The memory-wall sweep (the anchor figure)

```
npm run bench:sweep
```

Sweeps the filter size from a few KiB up to tens of MiB and measures `addHashes`
and `hasHashes` at each size. As the table outgrows L2 then L3, each probe
becomes a cache miss and throughput drops. The console marks where the table
crosses each cache level (read from sysfs); the CSV
(`bench/results/sweep-<kernel>-<timestamp>.csv`) is the plot data.

Cap the largest size with `BENCH_SWEEP_MAX` if memory is tight:

```
BENCH_SWEEP_MAX=8000000 npm run bench:sweep
```

## 5. False-positive accuracy on its own

```
npm run bench:fp
```

Runs the accuracy study at many seeds (default 60) without the timing suite, so
you can confirm the delivered rate matches the model with tight error bars.
"matches" means the model prediction lands inside the delivered CI; otherwise
the row shows the percentage it is off by.

## Knobs

| Variable            | Default     | Effect                                      |
| ------------------- | ----------- | ------------------------------------------- |
| `BENCH_N`           | `1000000`   | keys per timing workload                    |
| `BENCH_REPS`        | `30` (`12` sweep) | timed reps per workload (use 50+ for cited runs) |
| `BENCH_WARMUP`      | `5` (`2` sweep)   | untimed warmup reps                         |
| `BENCH_FP_SEEDS`    | `24` suite, `60` standalone | independent seeds for the FP study |
| `BENCH_SWEEP_MAX`   | `16000000`  | largest key count in the sweep              |
| `THOTH_FORCE_KERNEL`| auto        | `scalar` or `avx2` to pin the kernel        |

## Output

`bench/results/` holds the JSON and CSV dumps. The directory is gitignored
because it fills with timestamped runs; `git add -f` the one dataset you cite in
the paper.

A reproducible run is fully described by: the printed environment block, the
commit hash (clean working tree), and the command with its knobs. Quote all
three next to any number.
