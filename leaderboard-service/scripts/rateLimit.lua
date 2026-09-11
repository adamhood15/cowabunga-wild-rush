-- KEYS[1] rate-limit counter key ("wplb:rl:{bucket}:{ip}")
-- ARGV[1] window_seconds
--
-- INCR and EXPIRE run as one atomic EVAL, closing a gap the previous
-- two-call version had: if the process died or the Redis connection
-- dropped between INCR and EXPIRE, the counter could be left with no TTL
-- at all — permanently rate-limiting that IP in that bucket until someone
-- manually cleared the key.
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
