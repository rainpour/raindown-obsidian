# Jumps out of blocks called from C, thousands of times in one method call, as one request, in the worker, which
# answers each in a Fiber, whose stack is small. It checks wasm/patches catches each jump, and keeps none of its stack.
class Jumps < Raindown::Node
  def rewrite
    count = 20_000
    rescued = broken = thrown = 0
    count.times do
      { jump: 1 }.each { raise 'jump' }
    rescue StandardError
      rescued += 1
    end
    count.times { broken += (1..3).each { break 1 if it == 2 } }
    count.times { thrown += catch(:jump) { [1].each { throw :jump, 1 } } }
    "#{rescued} rescued, #{broken} broken, #{thrown} thrown"
  end
end
