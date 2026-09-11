<?php
if (!defined('ABSPATH')) exit;

/**
 * Public REST routes. The leaderboard routes (/claim, /submit, /leaderboard,
 * /rank, /names) moved to leaderboard-service/ on Railway — see
 * /Users/Adam.Hood/.claude/plans/lazy-rolling-matsumoto.md. All that's left
 * here is the gate-token route the signup funnel needs, which stays in
 * WordPress since it's entangled with WS Form/Mailchimp and is low-volume
 * (one hit per player, not per-run).
 */
class Waterpark_Leaderboard_REST_Controller {

    const NAMESPACE_ = 'waterpark-leaderboard/v1';

    public static function register_routes() {
        register_rest_route(self::NAMESPACE_, '/gate-token', array(
            'methods'             => 'GET',
            'callback'            => array(__CLASS__, 'gate_token'),
            'permission_callback' => '__return_true',
        ));
    }

    // Powers the gate page's fetch-token-then-redirect-on-submit flow — see
    // Waterpark_Leaderboard_Gate for what the token actually proves.
    //
    // Must never be cached: a 2026-09-07 investigation found Kinsta's edge
    // serving the same response (age 3589s+) to every visitor for up to an
    // hour, so most visitors received an already-expired 15-minute token —
    // reproduced as the reported "success message, then redirect bounces
    // back to the gate page" bug. no_cache_headers() plus the explicit
    // Cache-Control here is the origin-side half of the fix; the edge
    // itself also needs a cache-exclusion rule for this path (see
    // TODOLIST.md), since it was overriding WP core's own default
    // REST no-cache headers.
    public static function gate_token(WP_REST_Request $request) {
        nocache_headers();
        $response = new WP_REST_Response(array('token' => Waterpark_Leaderboard_Gate::issue_token()), 200);
        $response->header('Cache-Control', 'no-store, max-age=0');
        return $response;
    }
}
