<?php
if (!defined('ABSPATH')) exit;

/**
 * Serves the game at /play/ as a bare document — no theme header/footer, no
 * enqueued theme/plugin scripts — gated behind a signed token from
 * Waterpark_Leaderboard_Gate. See ARCHITECTURE.md/DATABASE.md for why: a
 * blank template avoids the load-time/frame-rate cost of everything else
 * WordPress would otherwise attach to the page.
 */
class Waterpark_Leaderboard_Game_Router {

    const QUERY_VAR       = 'waterpark_game';
    // Stores a page ID (not a URL) so this and Waterpark_Leaderboard_Gate_Page
    // share one source of truth for "which page is the gate."
    const GATE_PAGE_OPTION = 'waterpark_gate_page_id';

    // Disabled (2026-09-07) as a temporary workaround: Kinsta's Edge
    // Caching serves the same /gate-token response to every visitor for up
    // to an hour regardless of origin Cache-Control headers, so tokens are
    // routinely already expired by the time a visitor submits the signup
    // form — see TODOLIST.md. Re-enable once Kinsta support excludes that
    // route from Edge Caching and the fix is confirmed (two curls a few
    // seconds apart returning different tokens).
    const GATE_ENABLED = false;

    // Matches the Cowabunga Vegas production path (2026-09-21):
    // env-cowabungavegasnew-cbvdev.kinsta.cloud/cowabunga-wild-rush/play/ —
    // this repo now targets that site, not Typhoon Texas (see AGENTS.md).
    // Bump WATERPARK_LEADERBOARD_ROUTES_VERSION whenever this changes again
    // — maybe_flush() only re-flushes rewrite rules on a version bump, not
    // on every plugin load.
    public static function register_routes() {
        add_rewrite_rule('^cowabunga-wild-rush/play/?$', 'index.php?' . self::QUERY_VAR . '=1', 'top');
    }

    public static function query_vars($vars) {
        $vars[] = self::QUERY_VAR;
        return $vars;
    }

    public static function maybe_flush() {
        $installed_version = get_option(WATERPARK_LEADERBOARD_ROUTES_VERSION_OPTION);

        if ($installed_version !== WATERPARK_LEADERBOARD_ROUTES_VERSION) {
            flush_rewrite_rules();
            update_option(WATERPARK_LEADERBOARD_ROUTES_VERSION_OPTION, WATERPARK_LEADERBOARD_ROUTES_VERSION);
        }
    }

    public static function template_include($template) {
        if (!get_query_var(self::QUERY_VAR)) {
            return $template;
        }

        if (self::GATE_ENABLED) {
            // A bookmarked/shared link inside a valid 15-minute token window
            // is still real content a crawler could pick up — keep it out
            // of search results so it can't compete with the real landing
            // page for SEO. Only meaningful while a token is required at
            // all (AGENTS.md) — an intentionally open game (GATE_ENABLED
            // false) should be indexable.
            header('X-Robots-Tag: noindex, nofollow');

            $token = isset($_GET['t']) ? $_GET['t'] : '';

            if (!Waterpark_Leaderboard_Gate::validate_token($token)) {
                wp_safe_redirect(self::gate_page_url());
                exit;
            }
        }

        $game_file = WATERPARK_LEADERBOARD_PATH . 'game/index.html';

        if (!file_exists($game_file)) {
            wp_die('Game build not found.', 'Waterpark Leaderboard', array('response' => 500));
        }

        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        readfile($game_file);
        exit;
    }

    protected static function gate_page_url() {
        $page_id = (int) get_option(self::GATE_PAGE_OPTION);
        $url     = $page_id ? get_permalink($page_id) : false;
        return $url ? $url : home_url('/');
    }
}
