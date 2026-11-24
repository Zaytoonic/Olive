/* For tools/build-rnnoise.js. RNNoise v0.2's plain-C path (src/vec.h, used when there is no AVX/SSE/NEON, as in
   WebAssembly) includes "os_support.h", which the release doesn't contain. It needs only these two, defined as in Opus. */
#ifndef OLIVE_OS_SUPPORT_H
#define OLIVE_OS_SUPPORT_H
#include <string.h>
#ifndef OPUS_INLINE
#define OPUS_INLINE inline
#endif
#define OPUS_CLEAR(dst, n) (memset((dst), 0, (n)*sizeof(*(dst))))
#endif
