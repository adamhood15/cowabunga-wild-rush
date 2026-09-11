<?php
if (!defined('ABSPATH')) exit;

/**
 * Signs a short-lived token when the WS Form gate page loads (see
 * DATABASE.md/TODOLIST.md — WS Form Pro's Mailchimp add-on has no
 * webhook/PHP action to mint this after a confirmed submission, so the
 * token proves "loaded the gate page recently," not "subscribed"). Good
 * enough to remove a permanent, shareable game URL for this promo use case.
 */
class Waterpark_Leaderboard_Gate {

    const SECRET_OPTION    = 'waterpark_gate_secret';
    const TOKEN_LIFETIME   = 900; // 15 minutes

    public static function ensure_secret() {
        if (!get_option(self::SECRET_OPTION)) {
            update_option(self::SECRET_OPTION, bin2hex(random_bytes(32)), false);
        }
    }

    public static function issue_token() {
        $expiry = time() + self::TOKEN_LIFETIME;
        return $expiry . '.' . self::sign($expiry);
    }

    public static function validate_token($token) {
        $token = (string) $token;
        $parts = explode('.', $token, 2);

        if (count($parts) !== 2 || !ctype_digit($parts[0])) {
            return false;
        }

        list($expiry, $signature) = $parts;

        if ((int) $expiry < time()) {
            return false;
        }

        return hash_equals(self::sign((int) $expiry), $signature);
    }

    protected static function sign($expiry) {
        return hash_hmac('sha256', (string) $expiry, get_option(self::SECRET_OPTION));
    }
}
