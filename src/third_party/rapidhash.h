/*
 * rapidhash - Very fast, high quality, platform-independent hashing algorithm.
 *
 * This is a vendored, single-header copy of the rapidhash construction (the
 * wyhash successor): MIT-licensed, pure C, no SIMD/AES required, seedable.
 * The default hash is vendored, not packaged, so the
 * addon builds with nothing but a C/C++ toolchain.
 *
 * Original algorithm: Copyright (c) 2024 Nicolas De Carli, MIT License.
 * Reproduced here for vendoring; behaviour is internally deterministic, which
 * is what the cross-kernel bit-exactness invariant relies on.
 */
#ifndef THOTH_RAPIDHASH_H
#define THOTH_RAPIDHASH_H

#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Default seed and secret (proven good-avalanche constants). */
#define RAPID_SEED 0xbdd89aa982704029ull

static const uint64_t rapid_secret[3] = {
	0x2d358dccaa6c78a5ull, 0x8bb84b93962eacc9ull, 0x4b33a62ed433d4a3ull};

/* 64-bit x 64-bit -> 128-bit multiply, returning low and high halves. */
static inline void rapid_mum(uint64_t *A, uint64_t *B) {
#if defined(__SIZEOF_INT128__)
	__uint128_t r = (__uint128_t)(*A) * (*B);
	*A = (uint64_t)r;
	*B = (uint64_t)(r >> 64);
#else
	uint64_t ha = *A >> 32, hb = *B >> 32;
	uint64_t la = (uint32_t)*A, lb = (uint32_t)*B;
	uint64_t rh = ha * hb, rm0 = ha * lb, rm1 = hb * la, rl = la * lb;
	uint64_t t = rl + (rm0 << 32), c = t < rl;
	uint64_t lo = t + (rm1 << 32);
	c += lo < t;
	uint64_t hi = rh + (rm0 >> 32) + (rm1 >> 32) + c;
	*A = lo;
	*B = hi;
#endif
}

static inline uint64_t rapid_mix(uint64_t A, uint64_t B) {
	rapid_mum(&A, &B);
	return A ^ B;
}

static inline uint64_t rapid_read64(const uint8_t *p) {
	uint64_t v;
	memcpy(&v, p, 8);
	return v;
}
static inline uint64_t rapid_read32(const uint8_t *p) {
	uint32_t v;
	memcpy(&v, p, 4);
	return v;
}
static inline uint64_t rapid_readSmall(const uint8_t *p, size_t k) {
	return (((uint64_t)p[0]) << 56) | (((uint64_t)p[k >> 1]) << 32) | p[k - 1];
}

static inline uint64_t rapidhash_withSeed(const void *key, size_t len,
										  uint64_t seed) {
	const uint8_t *p = (const uint8_t *)key;
	const uint64_t *secret = rapid_secret;
	seed ^= rapid_mix(seed ^ secret[0], secret[1]) ^ len;
	uint64_t a = 0, b = 0;
	if (len <= 16) {
		if (len >= 4) {
			const uint8_t *plast = p + len - 4;
			a = (rapid_read32(p) << 32) | rapid_read32(plast);
			const uint64_t delta = ((len & 24) >> (len >> 3));
			b = ((rapid_read32(p + delta) << 32) | rapid_read32(plast - delta));
		} else if (len > 0) {
			a = rapid_readSmall(p, len);
			b = 0;
		} else {
			a = b = 0;
		}
	} else {
		size_t i = len;
		if (i > 48) {
			uint64_t see1 = seed, see2 = seed;
			do {
				seed = rapid_mix(rapid_read64(p) ^ secret[0],
								 rapid_read64(p + 8) ^ seed);
				see1 = rapid_mix(rapid_read64(p + 16) ^ secret[1],
								 rapid_read64(p + 24) ^ see1);
				see2 = rapid_mix(rapid_read64(p + 32) ^ secret[2],
								 rapid_read64(p + 40) ^ see2);
				p += 48;
				i -= 48;
			} while (i >= 48);
			seed ^= see1 ^ see2;
		}
		if (i > 16) {
			seed = rapid_mix(rapid_read64(p) ^ secret[2],
							 rapid_read64(p + 8) ^ seed ^ secret[1]);
			if (i > 32)
				seed = rapid_mix(rapid_read64(p + 16) ^ secret[2],
								 rapid_read64(p + 24) ^ seed);
		}
		a = rapid_read64(p + i - 16);
		b = rapid_read64(p + i - 8);
	}
	a ^= secret[1];
	b ^= seed;
	rapid_mum(&a, &b);
	return rapid_mix(a ^ secret[0] ^ len, b ^ secret[1]);
}

static inline uint64_t rapidhash(const void *key, size_t len) {
	return rapidhash_withSeed(key, len, RAPID_SEED);
}

/* splitmix64 finalizer for the integer-key fast path: cheap, strong mix
 * so sequential / low-entropy ints don't clump in block/lane selection. */
static inline uint64_t rapid_splitmix(uint64_t x, uint64_t seed) {
	x += seed + 0x9e3779b97f4a7c15ull;
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
	x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
	return x ^ (x >> 31);
}

#ifdef __cplusplus
}
#endif

#endif /* THOTH_RAPIDHASH_H */
