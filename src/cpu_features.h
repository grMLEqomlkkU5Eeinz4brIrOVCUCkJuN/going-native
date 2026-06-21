/* CPU feature probes, centralized. Per-compiler:
 * __builtin_cpu_supports on GCC/Clang, __cpuidex + _xgetbv on MSVC. */
#ifndef THOTH_CPU_FEATURES_H
#define THOTH_CPU_FEATURES_H

int thoth_cpu_has_avx2();
int thoth_cpu_has_avx512f();

#endif /* THOTH_CPU_FEATURES_H */
