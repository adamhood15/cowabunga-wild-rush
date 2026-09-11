<?php
/**
 * Plugin Name: Waterpark Leaderboard
 * Description: Custom table storage and REST submission layer for the Cowabunga waterpark game leaderboard. See DATABASE.md for the schema design.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) exit;

define('WATERPARK_LEADERBOARD_VERSION', '1.0.0');
define('WATERPARK_LEADERBOARD_PATH', plugin_dir_path(__FILE__));

// Bump whenever a rewrite rule in class-game-router.php changes — a plugin
// file update doesn't re-fire the activation hook, so rules are re-flushed
// via maybe_flush() on plugins_loaded instead, mirroring the DB version
// drift check below.
define('WATERPARK_LEADERBOARD_ROUTES_VERSION', '1.2');
define('WATERPARK_LEADERBOARD_ROUTES_VERSION_OPTION', 'waterpark_leaderboard_routes_version');

require_once WATERPARK_LEADERBOARD_PATH . 'includes/class-gate.php';
require_once WATERPARK_LEADERBOARD_PATH . 'includes/class-game-router.php';
require_once WATERPARK_LEADERBOARD_PATH . 'includes/class-gate-page.php';
require_once WATERPARK_LEADERBOARD_PATH . 'includes/class-rest-controller.php';

register_activation_hook(__FILE__, array('Waterpark_Leaderboard_Gate', 'ensure_secret'));

add_action('plugins_loaded', array('Waterpark_Leaderboard_Gate', 'ensure_secret'));

add_action('rest_api_init', array('Waterpark_Leaderboard_REST_Controller', 'register_routes'));

add_action('init', array('Waterpark_Leaderboard_Game_Router', 'register_routes'));
add_action('init', array('Waterpark_Leaderboard_Game_Router', 'maybe_flush'), 20);
add_filter('query_vars', array('Waterpark_Leaderboard_Game_Router', 'query_vars'));
add_filter('template_include', array('Waterpark_Leaderboard_Game_Router', 'template_include'));

add_action('wp_footer', array('Waterpark_Leaderboard_Gate_Page', 'maybe_print_snippet'));
