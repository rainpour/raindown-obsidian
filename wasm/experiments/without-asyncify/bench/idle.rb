# bench.rb's and hash.rb's workloads, timed with GC disabled in each round and GC run between rounds, as a worker
# would collect only between requests; normal.rb times them with GC as usual. Prints each median and the median GC.
DIR = __dir__
IDLE = !defined?(NORMAL)
eval(File.read(File.join(DIR, 'bench.rb')).split("\ntimes = ")[0])
w = WORKLOADS.dup
eval(File.read(File.join(DIR, 'hash.rb')).split("\ntimes = ")[0].sub('WORKLOADS =', 'HW ='))
w.merge!(HW)
times = Hash.new { |h, k| h[k] = [] }
gcs = []
12.times do |round|
  w.each do |name, work|
    GC.disable if IDLE
    t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    work.call
    times[name] << (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t) * 1000 if round >= 4
    next unless IDLE
    GC.enable
    t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    GC.start
    gcs << (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t) * 1000 if round >= 4
  end
end
times.each { |name, all| all.sort!; printf("%-28s %8.1f\n", name, all[all.size / 2]) }
gcs.sort!
printf("GC between, median %.1f ms, total %.0f ms over %d\n", gcs[gcs.size / 2] || 0, gcs.sum, gcs.size)
