# Enumerator#next under GC.stress, whose Fiber, made in C, only a local points to while it's made, which
# --spill-pointers alone, without --flatten, leaves on WebAssembly's stack, where garbage collection can't find it.
def try(name) = (puts "#{name}: #{yield.inspect}" rescue puts "#{name}: !#{$!.class}: #{$!.message}")
GC.stress = true
try('one next') { %w[a b].each.next }
try('two next') { e = %w[a b].each; [e.next, e.next] }
try('block fiber yields twice') { f = Fiber.new { Fiber.yield 1; Fiber.yield 2 }; [f.resume, f.resume] }
try('fiber from each') { f = Fiber.new { [1, 2].each { Fiber.yield it } }; [f.resume, f.resume] }
try('Enumerator.new') { e = Enumerator.new { |y| y << 1; y << 2 }; [e.next, e.next] }
GC.stress = false
try('two next, no stress') { e = %w[a b].each; [e.next, e.next] }
