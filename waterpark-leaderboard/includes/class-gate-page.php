<?php
if (!defined('ABSPATH')) exit;

/**
 * Outputs the fetch-token / redirect-on-submit snippet on whatever page is
 * configured as the gate (`waterpark_gate_page_id`, shared with
 * Waterpark_Leaderboard_Game_Router). Lives in the plugin rather than
 * code-snippets — Code Snippets scopes by everywhere/front-end/admin, not
 * by a specific page, without its Pro conditional-logic add-on.
 *
 * The gate page runs the hand-built Mailchimp embed form from
 * web-components/landing/landing.html (#mc-embedded-subscribe-form) —
 * web-components/mailchimp-form/mailchimp-form.js owns that form's field
 * validation and JSONP submission, and calls
 * window.WaterparkGate.redirectToGame() itself once Mailchimp confirms the
 * subscribe succeeded. This snippet only needs to fetch the token and
 * expose that one function.
 */
class Waterpark_Leaderboard_Gate_Page {

    const PAGE_ID_OPTION = 'waterpark_gate_page_id';

    public static function maybe_print_snippet() {
        $gate_page_id = (int) get_option(self::PAGE_ID_OPTION);

        if (!$gate_page_id || !is_page($gate_page_id)) {
            return;
        }

        $token_endpoint = esc_url_raw(rest_url('waterpark-leaderboard/v1/gate-token'));
        // Must match Waterpark_Leaderboard_Game_Router's rewrite rule.
        $game_url       = esc_url_raw(home_url('/stampede-wild-rush/play/'));
        ?>
        <script>
        (function () {
          var gameUrl = <?php echo wp_json_encode($game_url); ?>;
          var token = null;

          fetch(<?php echo wp_json_encode($token_endpoint); ?>)
            .then(function (r) { return r.json(); })
            .then(function (data) { token = data.token; })
            .catch(function (e) { console.error('Waterpark gate: token fetch failed', e); });

          window.WaterparkGate = {
            redirectToGame: function () {
              // Safety net — mailchimp-form.js's own validation should
              // already have blocked getting here without the consent
              // checkbox checked.
              var ack = document.getElementById('mc-SMSPHONE-ack');
              if (!ack || !ack.checked) {
                console.error('Waterpark gate: reached redirectToGame() without the consent checkbox checked, not redirecting');
                return;
              }
              if (!token) {
                console.error('Waterpark gate: no token yet, cannot redirect');
                return;
              }
              location.href = gameUrl + '?t=' + encodeURIComponent(token);
            },
          };
        })();
        </script>
        <?php
    }
}
