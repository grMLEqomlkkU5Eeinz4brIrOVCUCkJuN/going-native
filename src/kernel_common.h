/*
 * Shared kernel math: block selection, lane salts, and the per-lane bit map.
 * Every kernel (scalar, AVX2, AVX-512) MUST derive bits from these exact
 * formulas so the tables are bit-identical across kernels.
 */
#ifndef THOTH_KERNEL_COMMON_H
#define THOTH_KERNEL_COMMON_H

#include <stddef.h>
#include <stdint.h>

/* Fixed Impala/Parquet lane salts. The first 8 are the canonical SBBF set; the
 * full 16 are used by the 512-bit geometry. These are FIXED,
 * randomness comes from the hash seed, not the salt. */
static const uint32_t THOTH_SALT[16] = {
	0x47b6137bu, 0x44974d91u, 0x8824ad5bu, 0xa2b7289du,
	0x705495c7u, 0x2df1424bu, 0x9efc4947u, 0x5c6bfb31u,
	0x12345db7u, 0xb0e3a1f9u, 0x6a09e667u, 0xbb67ae85u,
	0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu};

/* Lemire's multiply-shift block selector, no division. */
static inline uint32_t thoth_block(uint64_t hash, uint32_t nblk) {
	return (uint32_t)(((uint64_t)(hash >> 32) * (uint64_t)nblk) >> 32);
}

/* One lane's bit position, 0..31, from the low 32 bits of the hash. */
static inline uint32_t thoth_lane_bit(uint32_t hlo, int lane) {
	return (uint32_t)((hlo * THOTH_SALT[lane]) >> 27);
}

#endif /* THOTH_KERNEL_COMMON_H */
