<?php
/**
 * WELL Collective - paid members endpoint for the app's admin analytics.
 * Paid = a Completed, non-zero order for Level 4 within the last 35 days
 * (Stripe or PayPal). Level 4 alone is not proof of payment: trial members
 * were bulk-moved onto it for free.
 */

add_action('rest_api_init', function () {
    register_rest_route('well/v1', '/paid-members', [
        'methods' => 'GET',
        'callback' => 'well_paid_members',
        'permission_callback' => function (WP_REST_Request $request) {
            $key = (string) $request->get_header('x-well-api-key');
            return defined('WELL_API_KEY') && $key !== '' && hash_equals(WELL_API_KEY, $key);
        },
    ]);
});

function well_paid_members(WP_REST_Request $request) {
    global $wpdb;
    $p = $wpdb->prefix;
    $rows = $wpdb->get_results(
        "SELECT LOWER(u.user_email) AS email,
                u.display_name AS name,
                MAX(o.create_date) AS last_paid,
                SUBSTRING_INDEX(GROUP_CONCAT(m.meta_value ORDER BY o.create_date DESC), ',', 1) AS gateway
         FROM {$p}ihc_orders o
         JOIN {$p}users u ON u.ID = o.uid
         LEFT JOIN {$p}ihc_orders_meta m ON m.order_id = o.id AND m.meta_key = 'ihc_payment_type'
         WHERE o.lid = 4 AND o.amount_value > 0 AND o.status = 'Completed'
           AND o.create_date > NOW() - INTERVAL 35 DAY
         GROUP BY u.ID"
    );
    return new WP_REST_Response(['members' => $rows], 200);
}

/**
 * Members whose Level 4 access ended in the last N days (default 30) and who have
 * no unexpired Level 4 now, with how many real payments they ever made.
 */
add_action('rest_api_init', function () {
    register_rest_route('well/v1', '/lapsed-members', [
        'methods' => 'GET',
        'callback' => 'well_lapsed_members',
        'permission_callback' => function (WP_REST_Request $request) {
            $key = (string) $request->get_header('x-well-api-key');
            return defined('WELL_API_KEY') && $key !== '' && hash_equals(WELL_API_KEY, $key);
        },
    ]);
});

function well_lapsed_members(WP_REST_Request $request) {
    global $wpdb;
    $p = $wpdb->prefix;
    $days = max(1, min(120, (int) ($request->get_param('days') ?: 30)));
    $rows = $wpdb->get_results($wpdb->prepare(
        "SELECT LOWER(u.user_email) AS email, u.display_name AS name,
                MAX(ul.expire_time) AS ended_at,
                (SELECT COUNT(*) FROM {$p}ihc_orders o
                  WHERE o.uid = u.ID AND o.lid = 4 AND o.amount_value > 0 AND o.status = 'Completed') AS paid_months
         FROM {$p}ihc_user_levels ul
         JOIN {$p}users u ON u.ID = ul.user_id
         WHERE ul.level_id = 4
         GROUP BY u.ID
         HAVING MAX(ul.expire_time) <= NOW() AND MAX(ul.expire_time) > NOW() - INTERVAL %d DAY",
        $days
    ));
    return new WP_REST_Response(['members' => $rows], 200);
}
