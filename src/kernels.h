/*
 * Kernel vtable + classic-kernel API. The C++ wrapper selects one kernel at
 * load time via CPU feature detection and routes all hot
 * paths through the function pointers. Classic (free-k) is scalar by design
 * and exposed directly.
 *
 * Pure C++ (no extern "C"): kernels, cpu_features, and the wrapper are all
 * C++ translation units, so symbols link without any linkage shim.
 */
#ifndef THOTH_KERNELS_H
#define THOTH_KERNELS_H

#include <cstddef>
#include <cstdint>

typedef struct thoth_kernel {
	const char *name;

	/* SBBF k=8 / 256-bit blocks (8 uint32 per block). */
	void (*sbbf256_insert_many)(uint32_t *t, uint32_t nblk, const uint64_t *h,
								size_t n);
	void (*sbbf256_query_many)(const uint32_t *t, uint32_t nblk,
							   const uint64_t *h, size_t n, uint8_t *out);

	/* SBBF k=16 / 512-bit blocks (16 uint32 per block). */
	void (*sbbf512_insert_many)(uint32_t *t, uint32_t nblk, const uint64_t *h,
								size_t n);
	void (*sbbf512_query_many)(const uint32_t *t, uint32_t nblk,
							   const uint64_t *h, size_t n, uint8_t *out);

	/* Whole-table set ops over nwords uint32 words. dst op= src. */
	void (*or_words)(uint32_t *dst, const uint32_t *src, size_t nwords);
	void (*and_words)(uint32_t *dst, const uint32_t *src, size_t nwords);
} thoth_kernel_t;

/* Kernel registries (one per translation unit). */
const thoth_kernel_t *thoth_kernel_scalar(void);
const thoth_kernel_t *thoth_kernel_avx2(void); /* NULL if not compiled in */

/* Classic cache-blocked kernel (free k 1..64), scalar. `blockWords` is the
 * uint32 words per block (8 = 256-bit, 16 = 512-bit); bit positions are chosen
 * mod blockWords*32. */
void thoth_classic_insert_many(uint32_t *t, uint32_t nblk, uint32_t k,
							   uint32_t blockWords, const uint64_t *h,
							   size_t n);
void thoth_classic_query_many(const uint32_t *t, uint32_t nblk, uint32_t k,
							  uint32_t blockWords, const uint64_t *h, size_t n,
							  uint8_t *out);

#endif /* THOTH_KERNELS_H */
