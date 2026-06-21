{
  "targets": [
    {
      # AVX2 kernel in its own C++ translation unit with -mavx2 / /arch:AVX2
      # Never -march=native: keep the default build portable.
      "target_name": "kernel_avx2",
      "type": "static_library",
      "cflags_cc!": [ "-fno-exceptions" ],
      "sources": [ "src/kernel_avx2.cpp" ],
      "include_dirs": [ "<(module_root_dir)/src" ],
      "cflags_cc": [ "-O3", "-std=c++17", "-mavx2" ],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": [ "-O3", "-std=c++17", "-mavx2" ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "EnableEnhancedInstructionSet": 3 }
      }
    },
    {
      "target_name": "addon",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-O3", "-std=c++17" ],
      "sources": [
        "src/addon.cc",
        "src/kernel_scalar.cpp",
        "src/cpu_features.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(module_root_dir)/src",
        "<(module_root_dir)"
      ],
      "dependencies": [
        "kernel_avx2",
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.13",
        "OTHER_CPLUSPLUSFLAGS": [ "-O3", "-std=c++17" ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      }
    }
  ]
}
