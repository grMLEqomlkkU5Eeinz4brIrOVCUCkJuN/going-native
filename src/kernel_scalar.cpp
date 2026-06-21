/*
 * Scalar reference kernel, the fallback path and the bit-exactness oracle
 * The SIMD kernels must reproduce these tables exactly.
 * Also hosts the classic (free-k) kernel and the whole-table set ops, both of
 * which are scalar by design.
 */
#include "kernel_common.h"
#include "kernels.h"

/* ---- SBBF 256-bit (k=8) -------------------------------------------------- */

static void sbbf256_insert_many(uint32_t *t, uint32_t nblk, const uint64_t *h,
								size_t n) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n) {
			uint32_t pb = thoth_block(h[i + PF], nblk);
			__builtin_prefetch(t + (size_t)pb * 8, 1, 0);
		}
		uint32_t blk = thoth_block(h[i], nblk);
		uint32_t hlo = (uint32_t)h[i];
		uint32_t *b = t + (size_t)blk * 8;
		for (int l = 0; l < 8; ++l)
			b[l] |= (1u << thoth_lane_bit(hlo, l));
	}
}

static void sbbf256_query_many(const uint32_t *t, uint32_t nblk,
							   const uint64_t *h, size_t n, uint8_t *out) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n) {
			uint32_t pb = thoth_block(h[i + PF], nblk);
			__builtin_prefetch(t + (size_t)pb * 8, 0, 0);
		}
		uint32_t blk = thoth_block(h[i], nblk);
		uint32_t hlo = (uint32_t)h[i];
		const uint32_t *b = t + (size_t)blk * 8;
		uint8_t present = 1;
		for (int l = 0; l < 8; ++l)
			if (!(b[l] & (1u << thoth_lane_bit(hlo, l)))) {
				present = 0;
				break;
			}
		out[i] = present;
	}
}

/* ---- SBBF 512-bit (k=16) ------------------------------------------------- */

static void sbbf512_insert_many(uint32_t *t, uint32_t nblk, const uint64_t *h,
								size_t n) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n) {
			uint32_t pb = thoth_block(h[i + PF], nblk);
			__builtin_prefetch(t + (size_t)pb * 16, 1, 0);
		}
		uint32_t blk = thoth_block(h[i], nblk);
		uint32_t hlo = (uint32_t)h[i];
		uint32_t *b = t + (size_t)blk * 16;
		for (int l = 0; l < 16; ++l)
			b[l] |= (1u << thoth_lane_bit(hlo, l));
	}
}

static void sbbf512_query_many(const uint32_t *t, uint32_t nblk,
							   const uint64_t *h, size_t n, uint8_t *out) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n) {
			uint32_t pb = thoth_block(h[i + PF], nblk);
			__builtin_prefetch(t + (size_t)pb * 16, 0, 0);
		}
		uint32_t blk = thoth_block(h[i], nblk);
		uint32_t hlo = (uint32_t)h[i];
		const uint32_t *b = t + (size_t)blk * 16;
		uint8_t present = 1;
		for (int l = 0; l < 16; ++l)
			if (!(b[l] & (1u << thoth_lane_bit(hlo, l)))) {
				present = 0;
				break;
			}
		out[i] = present;
	}
}

/* ---- whole-table set ops ------------------------------------------------- */

static void or_words(uint32_t *dst, const uint32_t *src, size_t nwords) {
	for (size_t i = 0; i < nwords; ++i)
		dst[i] |= src[i];
}
static void and_words(uint32_t *dst, const uint32_t *src, size_t nwords) {
	for (size_t i = 0; i < nwords; ++i)
		dst[i] &= src[i];
}

static const thoth_kernel_t SCALAR = {"scalar",			  sbbf256_insert_many,
									  sbbf256_query_many, sbbf512_insert_many,
									  sbbf512_query_many, or_words,
									  and_words};

const thoth_kernel_t *thoth_kernel_scalar(void) { return &SCALAR; }

/* ---- classic cache-blocked kernel (free k) -------------------------------
 * blockWords uint32 per block (8 = 256-bit, 16 = 512-bit). The block is split
 * into k disjoint partitions and each key sets exactly one bit in every
 * partition. That keeps a key's k probes from colliding and makes the k query
 * bits independent, which is what lets the false-positive model in config.ts
 * predict the delivered rate. Positions are fully determined by the 64-bit
 * digest, so the table is bit-identical regardless of kernel. */

/* Split blockBits into k near-equal partitions (sizes differ by at most one).
 */
static inline void classic_partitions(uint32_t k, uint32_t blockBits,
									  uint32_t *pStart, uint32_t *pSize) {
	for (uint32_t i = 0; i < k; ++i) {
		uint32_t s = (uint32_t)(((uint64_t)i * blockBits) / k);
		uint32_t e = (uint32_t)(((uint64_t)(i + 1) * blockBits) / k);
		pStart[i] = s;
		pSize[i] = e - s;
	}
}

/* One bit per partition. Each probe's within-partition index comes from an
 * independent avalanche mix of the digest (splitmix step + murmur3 finalizer),
 * not a double-hashing step: a plain `a += high32(hash)` reuses the bits
 * thoth_block selects with, so every probe for keys sharing a block would
 * cluster onto the same positions. The mix decorrelates the index from the
 * block selector; the Lemire multiply-shift maps it into the partition without
 * a division. */
static inline void classic_bits(uint64_t hash, uint32_t *posbuf, uint32_t k,
								const uint32_t *pStart, const uint32_t *pSize) {
	for (uint32_t i = 0; i < k; ++i) {
		uint64_t x = hash + (uint64_t)i * 0x9e3779b97f4a7c15ull;
		x ^= x >> 33;
		x *= 0xff51afd7ed558ccdull;
		x ^= x >> 33;
		x *= 0xc4ceb9fe1a85ec53ull;
		x ^= x >> 33;
		uint32_t g = (uint32_t)(x >> 32);
		uint32_t idx = (uint32_t)(((uint64_t)g * pSize[i]) >> 32);
		posbuf[i] = pStart[i] + idx;
	}
}

void thoth_classic_insert_many(uint32_t *t, uint32_t nblk, uint32_t k,
							   uint32_t blockWords, const uint64_t *h,
							   size_t n) {
	enum { PF = 8 };
	uint32_t pos[64], pStart[64], pSize[64];
	classic_partitions(k, blockWords * 32u, pStart, pSize);
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n) {
			uint32_t pb = thoth_block(h[i + PF], nblk);
			__builtin_prefetch(t + (size_t)pb * blockWords, 1, 0);
		}
		uint32_t blk = thoth_block(h[i], nblk);
		uint32_t *b = t + (size_t)blk * blockWords;
		classic_bits(h[i], pos, k, pStart, pSize);
		for (uint32_t j = 0; j < k; ++j)
			b[pos[j] >> 5] |= (1u << (pos[j] & 31));
	}
}

void thoth_classic_query_many(const uint32_t *t, uint32_t nblk, uint32_t k,
							  uint32_t blockWords, const uint64_t *h, size_t n,
							  uint8_t *out) {
	enum { PF = 8 };
	uint32_t pos[64], pStart[64], pSize[64];
	classic_partitions(k, blockWords * 32u, pStart, pSize);
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n) {
			uint32_t pb = thoth_block(h[i + PF], nblk);
			__builtin_prefetch(t + (size_t)pb * blockWords, 0, 0);
		}
		uint32_t blk = thoth_block(h[i], nblk);
		const uint32_t *b = t + (size_t)blk * blockWords;
		classic_bits(h[i], pos, k, pStart, pSize);
		uint8_t present = 1;
		for (uint32_t j = 0; j < k; ++j)
			if (!(b[pos[j] >> 5] & (1u << (pos[j] & 31)))) {
				present = 0;
				break;
			}
		out[i] = present;
	}
}
