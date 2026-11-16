DIR = __dir__
eval(File.read(File.join(__dir__, 'bench.rb')).split("\ntimes = ")[0])
small = Reader.new(TEXT.lines.first(1500).join)
GC.stress = true
table = RbWork.new(n: 1).rewrite(raindown: small)
errors = (1..200).map { |i| begin; raise ArgumentError, "e#{i}"; rescue => e; e.message; ensure; "x#{i}"; end }
thrown = (1..200).sum { |i| catch(:t) { [i].each { throw :t, i * 2 } } }
hash = (1..500).to_h { ["k#{it}", [it.to_s] * 2] }.sum { |k, v| k.size + v.join.size }
GC.stress = false
puts [table.sum(32), errors.last, thrown, hash, GC.count].join(' ')
