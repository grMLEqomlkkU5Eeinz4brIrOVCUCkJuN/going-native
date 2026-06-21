/*
 * AVX2 kernel. Compiled in its own translation unit with
 * -mavx2 / /arch:AVX2 and selected at runtime only when the CPU supports AVX2.
 * Produces bit-identical tables to the scalar kernel (same salts/shift math).
 */
#if defined(__AVX2__)
#include <immintrin.h>

#include "kernel_common.h"
#include "kernels.h"

static inline __m256i mask_lo(uint32_t hlo, const uint32_t *salt) {
	__m256i h = _mm256_set1_epi32((int)hlo);
	__m256i s = _mm256_loadu_si256((const __m256i *)salt);
	__m256i x = _mm256_srli_epi32(_mm256_mullo_epi32(h, s), 27); /* 0..31 */
	return _mm256_sllv_epi32(_mm256_set1_epi32(1), x);
}

static void sbbf256_insert_many(uint32_t *t, uint32_t nblk, const uint64_t *h,
								size_t n) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n)
			__builtin_prefetch(t + (size_t)thoth_block(h[i + PF], nblk) * 8, 1,
							   0);
		__m256i *b = (__m256i *)(t + (size_t)thoth_block(h[i], nblk) * 8);
		__m256i m = mask_lo((uint32_t)h[i], THOTH_SALT);
		_mm256_storeu_si256(b, _mm256_or_si256(_mm256_loadu_si256(b), m));
	}
}

static void sbbf256_query_many(const uint32_t *t, uint32_t nblk,
							   const uint64_t *h, size_t n, uint8_t *out) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n)
			__builtin_prefetch(t + (size_t)thoth_block(h[i + PF], nblk) * 8, 0,
							   0);
		const __m256i *b =
			(const __m256i *)(t + (size_t)thoth_block(h[i], nblk) * 8);
		__m256i m = mask_lo((uint32_t)h[i], THOTH_SALT);
		out[i] = (uint8_t)_mm256_testc_si256(_mm256_loadu_si256(b), m);
	}
}

static void sbbf512_insert_many(uint32_t *t, uint32_t nblk, const uint64_t *h,
								size_t n) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n)
			__builtin_prefetch(t + (size_t)thoth_block(h[i + PF], nblk) * 16, 1,
							   0);
		uint32_t *blk = t + (size_t)thoth_block(h[i], nblk) * 16;
		__m256i *b0 = (__m256i *)blk;
		__m256i *b1 = (__m256i *)(blk + 8);
		__m256i m0 = mask_lo((uint32_t)h[i], THOTH_SALT);
		__m256i m1 = mask_lo((uint32_t)h[i], THOTH_SALT + 8);
		_mm256_storeu_si256(b0, _mm256_or_si256(_mm256_loadu_si256(b0), m0));
		_mm256_storeu_si256(b1, _mm256_or_si256(_mm256_loadu_si256(b1), m1));
	}
}

static void sbbf512_query_many(const uint32_t *t, uint32_t nblk,
							   const uint64_t *h, size_t n, uint8_t *out) {
	enum { PF = 8 };
	for (size_t i = 0; i < n; ++i) {
		if (i + PF < n)
			__builtin_prefetch(t + (size_t)thoth_block(h[i + PF], nblk) * 16, 0,
							   0);
		const uint32_t *blk = t + (size_t)thoth_block(h[i], nblk) * 16;
		__m256i m0 = mask_lo((uint32_t)h[i], THOTH_SALT);
		__m256i m1 = mask_lo((uint32_t)h[i], THOTH_SALT + 8);
		int ok =
			_mm256_testc_si256(_mm256_loadu_si256((const __m256i *)blk), m0) &
			_mm256_testc_si256(_mm256_loadu_si256((const __m256i *)(blk + 8)),
							   m1);
		out[i] = (uint8_t)ok;
	}
}

static void or_words(uint32_t *dst, const uint32_t *src, size_t nwords) {
	size_t i = 0;
	for (; i + 8 <= nwords; i += 8) {
		__m256i a = _mm256_loadu_si256((const __m256i *)(dst + i));
		__m256i b = _mm256_loadu_si256((const __m256i *)(src + i));
		_mm256_storeu_si256((__m256i *)(dst + i), _mm256_or_si256(a, b));
	}
	for (; i < nwords; ++i)
		dst[i] |= src[i];
}
static void and_words(uint32_t *dst, const uint32_t *src, size_t nwords) {
	size_t i = 0;
	for (; i + 8 <= nwords; i += 8) {
		__m256i a = _mm256_loadu_si256((const __m256i *)(dst + i));
		__m256i b = _mm256_loadu_si256((const __m256i *)(src + i));
		_mm256_storeu_si256((__m256i *)(dst + i), _mm256_and_si256(a, b));
	}
	for (; i < nwords; ++i)
		dst[i] &= src[i];
}

static const thoth_kernel_t AVX2 = {"avx2",
									sbbf256_insert_many,
									sbbf256_query_many,
									sbbf512_insert_many,
									sbbf512_query_many,
									or_words,
									and_words};

const thoth_kernel_t *thoth_kernel_avx2(void) { return &AVX2; }

#else
#include "kernels.h"
const thoth_kernel_t *thoth_kernel_avx2(void) {
	return (const thoth_kernel_t *)0;
}
#endif
