-- KEYS[1] player_key    ("wplb:{game}:player:{token}")
-- KEYS[2] board_zset    ("wplb:{game}:board")
-- KEYS[3] unplayed_zset ("wplb:{game}:unplayed")
-- ARGV[1] token
-- ARGV[2] new score
-- ARGV[3] new created_at (unix seconds)
-- ARGV[4] new composite score for the board zset
--
-- Returns -1 if the token is unclaimed, 1 if the score advanced, 0
-- otherwise. Only ever moves score/created_at forward — mirrors
-- upsert_score()'s IF(VALUES(score) > score, ...) guard from the old
-- MySQL repository, so a resubmitted lower score never overwrites a real
-- personal best.
local cur = tonumber(redis.call('HGET', KEYS[1], 'score'))
if cur == nil then
  return -1
end
if tonumber(ARGV[2]) > cur then
  redis.call('HSET', KEYS[1], 'score', ARGV[2], 'created_at', ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return 1
end
return 0
