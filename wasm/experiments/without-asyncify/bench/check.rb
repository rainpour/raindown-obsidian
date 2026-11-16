DIR = __dir__
eval(File.read(File.join(__dir__, 'bench.rb')).split("\ntimes = ")[0])
out = []
out << RbWork.new(n: 1).rewrite(raindown: READER)
out << (begin; raise ArgumentError, 'x'; rescue => e; e.message; end)
out << catch(:k) { [1, 2].each { throw :k, 42 } }
out << (begin; [1].each { break 7 }; ensure; out << :ensured; end)
# Objects held only in locals across allocations, under GC.stress, which a missed local would free early.
GC.stress = true
kept = (1..300).map { |i| s = "str#{i}"; a = [s, i.to_s]; GC.start if i % 50 == 0; a.join('-') }
GC.stress = false
out << kept.last << kept.sum(&:size)
out << (1..20_000).map { [it, it.to_s] }.sum { it[1].size }
puts out.map(&:to_s).join("\n").then { "#{it.sum(32)} #{it.lines.last(5).join.tr("\n", ' ')}" }
