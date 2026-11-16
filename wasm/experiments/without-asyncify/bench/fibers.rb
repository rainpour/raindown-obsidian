# Fibers, as JSPI switches them without Asyncify, which run-jspi.js checks against native Ruby's, some under GC.stress.
out = []
f = Fiber.new { |x| y = Fiber.yield(x * 2); Fiber.yield(y + 1); :done }
out << f.resume(5) << f.resume(10) << f.resume << f.alive?
e = [1, 2, 3].each
out << e.next << e.next << e.next << (begin; e.next; rescue StopIteration; :stop; end)
gen = Enumerator.new { |y| 3.times { |i| y << i * i } }
out << gen.next << gen.peek << gen.take(3).inspect
outer = Fiber.new { inner = Fiber.new { Fiber.yield :inner; :inner_done }; [inner.resume, Fiber.yield(:outer), inner.resume] }
out << outer.resume << outer.resume(:back).inspect
out << (begin; Fiber.new { raise ArgumentError, 'in fiber' }.resume; rescue ArgumentError => error; error.message; end)
log = []; Fiber.new { begin; Fiber.yield; ensure; log << :ensured; end }.tap(&:resume).resume; out << log.inspect
GC.stress = true
fibers = (1..30).map { |i| Fiber.new { s = "f#{i}"; Fiber.yield s; s * 2 } }
out << fibers.map(&:resume).last << fibers.map(&:resume).last
GC.stress = false
out << (1..2000).map { |i| Fiber.new { i }.resume }.sum
puts out.join(' ')
