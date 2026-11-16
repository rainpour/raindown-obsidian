#!/bin/bash
# A minimal ruby.wasm, without gems or the js gem, configured as the plugin's, for timing Ruby itself: from Ruby 4.0's
# tarball in rbwasm's build folder, with the plugin's jumps and shapes patches and Asyncify, or with eh, this folder's
# patch and the shapes patch, without Asyncify. bin/build fetches what it needs, like the tarball, the first time.
#   wasm/experiments/without-asyncify/build.sh OUT [eh]
# Each is OUT/ruby. Without Asyncify, it needs a Binaryen with --spill-pointers, like version_131, as BINARYEN, and a
# wasi-sdk with LLVM 19 or later, like wasi-sdk 34, as WASI_SDK, is faster than rbwasm's wasi-sdk 24.
set -e
OUT=$(mkdir -p "$1" && cd "$1" && pwd) MODE=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
B=$ROOT/build/ruby_wasm/build
T=${WASI_SDK:-$B/toolchain/wasi-sdk-24.0}
BASE=$B/x86_64-apple-darwin25/baseruby-4.0
WASMOPT=$B/toolchain/binaryen/bin/wasm-opt
[ -n "$BINARYEN" ] && WASMOPT=$BINARYEN/bin/wasm-opt
EH_FLAGS="" LIBS="" CPPFLAGS="" PATCHES="$ROOT/wasm/patches/ruby-4.0-wasm-jumps.patch"
if [ "$MODE" = eh ]; then
  [ -n "$BINARYEN" ] || { echo "Set BINARYEN to a Binaryen with --spill-pointers, like version_131" >&2; exit 1; }
  EH_FLAGS="-mllvm -wasm-enable-sjlj -mexception-handling" LIBS="-lsetjmp" CPPFLAGS="-DRB_WASM_EH"
  PATCHES="$HERE/ruby-4.0-without-asyncify.patch"
fi

rm -rf "$OUT/src" && mkdir -p "$OUT/src"
tar xzf "$B/checkouts/4.0.tar.gz" -C "$OUT/src" --strip-components 1
for patch in $PATCHES "$ROOT/wasm/patches/ruby-4.0-wasm-shapes.patch"; do patch -d "$OUT/src" -p1 -s < "$patch"; done

cd "$OUT"
# Without -g, as Binaryen 131's DWARF handling fails on Ruby's, which leaves the module as it was linked.
"$OUT/src/configure" --host wasm32-wasi --build x86_64-apple-darwin25 --with-static-linked-ext --with-ext=etc \
  --with-baseruby="$BASE/opt/bin/ruby" --with-dump-ast="$BASE/dump_ast" \
  WASMOPT="$WASMOPT" WASI_SDK_PATH="$T" \
  CC="$T/bin/clang" CXX="$T/bin/clang++" LD="$T/bin/clang" AR="$T/bin/llvm-ar" RANLIB="$T/bin/llvm-ranlib" \
  LDFLAGS="-Xlinker --stack-first -Xlinker -z -Xlinker stack-size=16777216 $EH_FLAGS" \
  LIBS="$LIBS" CFLAGS="$EH_FLAGS" cppflags="$CPPFLAGS" \
  XCFLAGS="-DWASM_SETJMP_STACK_BUFFER_SIZE=24576 -DWASM_FIBER_STACK_BUFFER_SIZE=24576 -DWASM_SCAN_STACK_BUFFER_SIZE=24576" \
  "wasmoptflags=-O3 --strip-dwarf --enable-exception-handling --pass-arg=asyncify-ignore-imports" \
  ac_cv_func_fchmod=no ac_cv_func_chmod=no ac_cv_func_realpath=no ac_cv_func_dlopen=no --disable-install-doc \
  > configure.log 2>&1
make -j6 ruby > make.log 2>&1
ls -la ruby
