# Jumps out of blocks called from C, thousands of times in one method call, as one request. Each leaked stack and
# memory in ruby.wasm before wasm/patches, so this failed with SystemStackError, or took minutes, in the worker, which
# answers each request in a Fiber.
class Jumps < Raindown::Node
  COUNT = 20_000

  def rewrite
    rescued = broken = thrown = 0
    COUNT.times do
      { jump: 1 }.each { raise 'jump' }
    rescue StandardError
      rescued += 1
    end
    COUNT.times { broken += (1..3).each { break 1 if it == 2 } }
    COUNT.times { thrown += catch(:jump) { [1].each { throw :jump, 1 } } }
    "#{rescued} rescued, #{broken} broken, #{thrown} thrown"
  end
end
