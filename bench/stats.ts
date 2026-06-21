/*
 * Small, dependency-free statistics for the benchmark harness.
 *
 * Timing distributions are right-skewed: a stray GC, an interrupt, or a
 * scheduler preemption only ever makes a run *slower*, never faster. The mean
 * and standard deviation assume a symmetry the data does not have, so the
 * harness summarises a sample with the median and a non-parametric bootstrap
 * confidence interval instead. The min (fastest run) is also reported, since it
 * is the estimate least contaminated by external noise.
 */

/** Linear-interpolated percentile of an ascending-sorted array. p in [0, 100]. */
export function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) return NaN;
	if (sortedAsc.length === 1) return sortedAsc[0];
	const idx = (p / 100) * (sortedAsc.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	return sortedAsc[lo] * (1 - (idx - lo)) + sortedAsc[hi] * (idx - lo);
}

export function median(xs: number[]): number {
	return percentile([...xs].sort((a, b) => a - b), 50);
}

export function mean(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (Bessel-corrected). */
export function stdev(xs: number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Median absolute deviation, scaled to estimate the stdev of clean data. */
export function mad(xs: number[]): number {
	const m = median(xs);
	return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** Deterministic PRNG, so reported confidence intervals are reproducible. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Percentile bootstrap CI for an arbitrary statistic. Resample the observed
 * runs with replacement B times, recompute the statistic on each resample, and
 * take the empirical [alpha/2, 1-alpha/2] quantiles. Makes no normality
 * assumption, which is the point: timing data is skewed.
 */
export function bootstrapCI(
	xs: number[],
	stat: (s: number[]) => number,
	rng: () => number,
	B = 2000,
	alpha = 0.05,
): [number, number] {
	const n = xs.length;
	if (n < 2) return [xs[0] ?? NaN, xs[0] ?? NaN];
	const stats = new Array<number>(B);
	const resample = new Array<number>(n);
	for (let b = 0; b < B; b++) {
		for (let i = 0; i < n; i++) resample[i] = xs[(rng() * n) | 0];
		stats[b] = stat(resample);
	}
	stats.sort((a, b) => a - b);
	return [percentile(stats, 100 * (alpha / 2)), percentile(stats, 100 * (1 - alpha / 2))];
}

/** Two CIs that do not overlap are a (conservative) signal of a real difference. */
export function ciOverlap(a: [number, number], b: [number, number]): boolean {
	return a[0] <= b[1] && b[0] <= a[1];
}
