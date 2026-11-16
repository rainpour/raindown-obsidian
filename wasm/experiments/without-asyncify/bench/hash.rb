# Array and Hash workloads, each timed in rounds after warm-up rounds, as the median ms.
STRS = (1..1000).map { "key#{it}" }.freeze
SYMS = STRS.map(&:to_sym).freeze
ARR = (1..1000).to_a.freeze
HS = STRS.to_h { [it, it.size] }.freeze
HY = SYMS.to_h { [it, 1] }.freeze
HI = ARR.to_h { [it, it] }.freeze
WORKLOADS = {
  'Array#each 200k' => -> { s = 0; 200.times { ARR.each { s += it } }; s },
  'Array#each_with_index 200k' => -> { s = 0; 200.times { ARR.each_with_index { |v, i| s += v + i } }; s },
  'while over Array 200k' => -> { s = 0; 200.times { i = 0; while i < 1000; s += ARR[i]; i += 1; end }; s },
  'Hash#each 200k' => -> { s = 0; 200.times { HI.each { |k, v| s += k + v } }; s },
  'Hash#each_value 200k' => -> { s = 0; 200.times { HI.each_value { s += it } }; s },
  'Hash[str] 200k' => -> { s = 0; 200.times { STRS.each { s += HS[it] } }; s },
  'Hash[sym] 200k' => -> { s = 0; 200.times { SYMS.each { s += HY[it] } }; s },
  'Hash[int] 200k' => -> { s = 0; 200.times { ARR.each { s += HI[it] } }; s },
  'Hash[str] += 200k' => -> { h = Hash.new(0); 200.times { STRS.each { h[it] += 1 } }; h.size },
  'Hash build str 100x1k' => -> { 100.times { STRS.to_h { [it, 1] } } },
  'Hash build int 100x1k' => -> { 100.times { h = {}; ARR.each { h[it] = it } } },
}
times = Hash.new { |h, k| h[k] = [] }
10.times do |round|
  WORKLOADS.each do |name, work|
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    work.call
    times[name] << (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000 if round >= 3
  end
end
times.each { |name, all| all.sort!; printf("%-28s %8.2f\n", name, all[all.size / 2]) }
