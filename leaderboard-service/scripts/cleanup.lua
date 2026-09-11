-- KEYS[1] unplayed_zset ("wplb:{game}:unplayed")
-- KEYS[2] names_set     ("wplb:{game}:names")
-- KEYS[3] player_key    ("wplb:{game}:player:{token}")
-- KEYS[4] board_zset    ("wplb:{game}:board")
-- ARGV[1] token
-- ARGV[2] name_key_prefix ("wplb:{game}:name:")
--
-- Re-checks two conditions immediately before deleting anything, closing
-- the race where /submit records a real score between cleanup's initial
-- ZRANGEBYSCORE scan (cleanup.js) and this deletion actually running:
-- (1) the token must still be present in :unplayed — submit.lua ZREMs it
-- the instant a real score lands — and (2) the player's stored score must
-- still be exactly 0, as a second independent guard. Either condition
-- failing means a legitimate submit won the race; this is then a no-op
-- and returns 0 rather than deleting a live player.
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 0
end

local score = redis.call('HGET', KEYS[3], 'score')
if score ~= '0' then
  return 0
end

local playerName = redis.call('HGET', KEYS[3], 'player_name')
if playerName then
  redis.call('SREM', KEYS[2], playerName)
  redis.call('DEL', ARGV[2] .. playerName)
end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
