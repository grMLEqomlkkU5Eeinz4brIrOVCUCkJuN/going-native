#include "cpu_features.h"

#if defined(_MSC_VER)
#include <intrin.h>

static int xcr0_has_avx(void) {
	unsigned long long xcr0 = _xgetbv(0);
	return (xcr0 & 0x6) == 0x6; /* XMM + YMM state enabled by OS */
}
static int xcr0_has_avx512(void) {
	unsigned long long xcr0 = _xgetbv(0);
	return (xcr0 & 0xE6) == 0xE6; /* + OPMASK/ZMM state */
}

int thoth_cpu_has_avx2(void) {
	int regs[4];
	__cpuid(regs, 0);
	if (regs[0] < 7)
		return 0;
	__cpuid(regs, 1);
	if (!(regs[2] & (1 << 28)))
		return 0; /* AVX */
	if (!xcr0_has_avx())
		return 0;
	__cpuidex(regs, 7, 0);
	return (regs[1] & (1 << 5)) != 0; /* AVX2 */
}

int thoth_cpu_has_avx512f(void) {
	int regs[4];
	__cpuid(regs, 0);
	if (regs[0] < 7)
		return 0;
	if (!xcr0_has_avx512())
		return 0;
	__cpuidex(regs, 7, 0);
	return (regs[1] & (1 << 16)) != 0; /* AVX512F */
}

#elif defined(__GNUC__) || defined(__clang__)

int thoth_cpu_has_avx2(void) {
	__builtin_cpu_init();
	return __builtin_cpu_supports("avx2");
}
int thoth_cpu_has_avx512f(void) {
	__builtin_cpu_init();
	return __builtin_cpu_supports("avx512f");
}

#else

int thoth_cpu_has_avx2(void) { return 0; }
int thoth_cpu_has_avx512f(void) { return 0; }

#endif
