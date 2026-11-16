// How long a setjmp, and a longjmp to it, take in WebAssembly, as V8 runs them, with and without a frame between that
// catches and rethrows, as a block's vm_exec does in Ruby.
#include <setjmp.h>
#include <stdio.h>
#include <time.h>

static jmp_buf outer;
static volatile int sink;

__attribute__((noinline)) static void thrower(void) { longjmp(outer, 1); }

__attribute__((noinline)) static void middle(void) {
  jmp_buf mine;
  if (setjmp(mine) == 0) thrower();
  sink++;
}

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

int main(void) {
  int n = 200000;
  for (int round = 0; round < 2; round++) {
    double t = now();
    for (int i = 0; i < n; i++) if (setjmp(outer) == 0) thrower();
    double direct = now() - t;
    t = now();
    for (int i = 0; i < n; i++) if (setjmp(outer) == 0) middle();
    double through = now() - t;
    t = now();
    for (int i = 0; i < n; i++) if (setjmp(outer) == 0) sink++;
    double set_only = now() - t;
    printf("setjmp only %.3f us, setjmp+longjmp %.3f us, through a frame that rethrows %.3f us\n",
           set_only * 1e3 / n, direct * 1e3 / n, through * 1e3 / n);
  }
}
