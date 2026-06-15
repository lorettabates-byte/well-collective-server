<?php
/**
 * WELL Collective - Membership status REST endpoint for the mobile app
 * Checks Level 4 (well_collectivemember) - the $30/30-day recurring subscription
 */

if (!defined('WELL_API_KEY')) {
    define('WELL_API_KEY', 'JKyF96hq4zVcOTZoagdUUPAYM4kwsJlg');
}

const WELL_MEMBER_LEVEL_ID = 4;

add_action('rest_api_init', function () {
    register_rest_route('well/v1', '/membership-status', [
        'methods' => 'GET',
        'callback' => 'well_membership_status',
        'permission_callback' => 'well_membership_permission_check',
    ]);
});

function well_membership_permission_check(WP_REST_Request $request) {
    $key = $request->get_header('x-well-api-key');
    return !empty($key) && hash_equals(WELL_API_KEY, (string) $key);
}

function well_membership_status(WP_REST_Request $request) {
    global $wpdb;

    $email = sanitize_email($request->get_param('email'));
    if (empty($email)) {
        return new WP_REST_Response(['error' => 'email required'], 400);
    }

    $user = get_user_by('email', $email);
    if (!$user) {
        return new WP_REST_Response(['active' => false, 'reason' => 'no_user'], 200);
    }

    $user_id = $user->ID;
    $active = false;
    $levels = [];

    $table = $wpdb->prefix . 'ihc_user_levels';
    $rows = $wpdb->get_results(
        $wpdb->prepare("SELECT level_id, status FROM {$table} WHERE user_id = %d", $user_id)
    );

    foreach ($rows as $row) {
        if (intval($row->status) === 1) {
            $levels[] = intval($row->level_id);
            if (intval($row->level_id) === WELL_MEMBER_LEVEL_ID) {
                $active = true;
            }
        }
    }

    $response = ['active' => $active, 'levels' => $levels];

    if ($request->get_param('debug') === '1') {
        $response['debug'] = ['user_id' => $user_id, 'rows' => $rows];
    }

    return new WP_REST_Response($response, 200);
}
