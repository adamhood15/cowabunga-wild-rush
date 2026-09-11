-- KEYS[1] name_key      ("wplb:{game}:name:{candidate}")
-- KEYS[2] player_key    ("wplb:{game}:player:{token}")
-- KEYS[3] names_set     ("wplb:{game}:names")
-- KEYS[4] board_zset    ("wplb:{game}:board")
-- KEYS[5] unplayed_zset ("wplb:{game}:unplayed")
-- ARGV[1] token
-- ARGV[2] player_name (candidate)
-- ARGV[3] session_id ("" if none)
-- ARGV[4] created_at (unix seconds; also the unplayed-tracker score)
-- ARGV[5] initial composite score for the board zset (score 0)
--
-- SET ... NX is the atomic "claim this name or lose the race" primitive —
-- it replaces the MySQL idx_game_name unique constraint + insert-failure
-- retry that class-name-pool.php::claim() used to rely on. A failed SET NX
-- here is exactly the "lost the race" signal insert_new() returning false
-- gave before; the caller retries with a new suffix either way.
if redis.call('SET', KEYS[1], ARGV[1], 'NX') then
  redis.call('HSET', KEYS[2],
    'player_name', ARGV[2],
    'score', '0',
    'created_at', ARGV[4],
    'session_id', ARGV[3])
  redis.call('SADD', KEYS[3], ARGV[2])
  redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
  return 1
end
return 0
