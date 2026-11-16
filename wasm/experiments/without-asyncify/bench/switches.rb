# Fiber switches, which JSPI makes through a microtask each, and blocks called from C, which each run vm_exec's
# setjmp, against blocks Ruby yields to, each timed in rounds after warm-up rounds, as the median ms.
ARR = (1..1000).to_a.freeze

WORKLOADS = {
  'Fiber resume/yield 20k' => -> { f = Fiber.new { loop { Fiber.yield } }; 20_000.times { f.resume } },
  'Enumerator#next 20k' => -> { 20.times { e = ARR.each; 1000.times { e.next } } },
  'Enumerator.new next 20k' => -> { e = Enumerator.new { |y| loop { y << 1 } }; 20_000.times { e.next } },
  'Integer#times 200k' => -> { s = 0; 200.times { 1000.times { s += it } }; s },
  'Range#each 200k' => -> { s = 0; 200.times { (0...1000).each { s += it } }; s },
}

times = Hash.new { |h, k| h[k] = [] }
ROUNDS = 12
WARMUP = 4
ROUNDS.times do |round|
  WORKLOADS.each do |name, work|
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    work.call
    times[name] << (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000 if round >= WARMUP
  end
end
times.each { |name, all| all.sort!; printf("%-24s %8.1f\n", name, all[all.size / 2]) }
