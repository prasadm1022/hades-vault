# C / C++

## Detect
- CMake: `CMakeLists.txt`, `CMakePresets.json`. Make: `Makefile`/`GNUmakefile`. Meson: `meson.build`.
  Autotools: `configure.ac`/`configure`. Bazel: `MODULE.bazel`/`WORKSPACE`/`BUILD`. MSBuild: `*.vcxproj`.
- Packages: `vcpkg.json`, `conanfile.txt`/`conanfile.py`, git submodules in `third_party/`/`external/`.
- Tooling: `.clang-format`, `.clang-tidy`, `compile_commands.json`; embedded: toolchain files, linker scripts (`*.ld`).

## Commands
| key | CMake | Meson | Make / Autotools | Bazel |
|---|---|---|---|---|
| install | vcpkg manifest: toolchain flag below; Conan 2: `conan install . --output-folder=build --build=missing` | (wraps in `subprojects/`) | `autoreconf -fi` if no `configure` | n/a |
| build | `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` then `cmake --build build --parallel` | `meson setup build` then `meson compile -C build` | `./configure` then `make -j4` | `bazel build //...` |
| lint | `run-clang-tidy -p build` or `cppcheck --project=build/compile_commands.json --enable=warning,performance --error-exitcode=1 --quiet` | same | same | same |
| types | n/a (compilation; keep the project's `-Wall -Wextra` / `/W4`) | | | |
| test | `ctest --test-dir build --output-on-failure` | `meson test -C build --print-errorlogs` | `make check` or `make test` | `bazel test //...` |
| format | `clang-format --dry-run --Werror <files>` | | | |

Presets: `cmake --preset <name>` + `cmake --build --preset <name>` when `CMakePresets.json` exists (use
them, they hold the real flags). Multi-config generators (Visual Studio, Xcode, Ninja Multi-Config):
`cmake --build build --config Debug` and `ctest --test-dir build -C Debug`. vcpkg:
`-DCMAKE_TOOLCHAIN_FILE=<VCPKG_ROOT>/scripts/buildsystems/vcpkg.cmake`; Conan: `-DCMAKE_TOOLCHAIN_FILE=build/conan_toolchain.cmake`.

## Layout
`include/<project>/` (public headers), `src/`, `tests/` (registered with `add_test`/`gtest_discover_tests`),
`cmake/` modules, `third_party/`. Out-of-source builds only (`build/`, never committed). One target per
library; link with `target_link_libraries(... PRIVATE ...)`, not global flags.

## Testing
- GoogleTest, Catch2, doctest (C++); Unity, CMocka, Check (C). Register every test with CTest.
- Sanitizers in a separate build dir: `-DCMAKE_C_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer"`
  (and `CMAKE_CXX_FLAGS`; GCC/Clang), MSVC `/fsanitize=address`. Valgrind on Linux for leak checks.
- Fuzzing parsers and decoders: libFuzzer (`-fsanitize=fuzzer`) with a time-boxed run.
- Embedded/hardware code: unit-test logic on the host; hardware-in-the-loop only when the team has a rig.

## Security
- Memory safety is the main risk: sanitizer test runs, `-D_FORTIFY_SOURCE=2`, stack protector, no
  `strcpy`/`sprintf`/`gets` (bounded variants), integer overflow on sizes, format strings from input.
- trivy reads `conan.lock`; vcpkg and vendored sources need manual version review (list them in
  `05-impl-*.md`). semgrep coverage of C/C++ is partial: add cppcheck/clang-tidy findings.
- Built binaries can be reviewed with REA: `../reverse-engineering.md`.

## Pitfalls
- Windows: MSVC needs its environment; the Visual Studio generator works from any shell, Ninja/NMake only
  inside a Developer prompt (`vcvars64.bat`). Do not mix MinGW and MSVC builds in one build dir.
- Reusing a build dir with another generator or compiler fails: use a new dir (`build-<variant>`).
- Long builds: `--parallel`, build only what you need (`--target <t>`), background + long timeout.
- `make` without `-j` is slow; `make -j` without a number can exhaust memory on big projects.
- Generated headers/config (`config.h`) come from the configure step: rerun configure after option changes.
- Never `make install` / `cmake --install` to system paths; use `--prefix`/`DESTDIR` into the build dir.

## Small output
Ninja (`-G Ninja`) prints one line per step; on failure `cmake --build build 2>&1 | grep -E "error|Error" | head -30`;
`ctest --output-on-failure` prints only failing tests' output; `meson test --print-errorlogs` likewise.
