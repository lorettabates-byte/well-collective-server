<?php
/**
 * WELL Collective - tells the app server the moment a website member cancels
 * or pays for Level 4, with UMP's built-in cancel reason, so the owner gets a
 * push and the analytics "Joins & Cancels" report stays current.
 * Deployed as wp-content/mu-plugins/well-membership-events.php.
 */

if (!defined('WELL_MEMBERSHIP_EVENTS_URL')) {
    define('WELL_MEMBERSHIP_EVENTS_URL', 'https://well-collective-server-production.up.railway.app/api/membership-events/website');
}

// The six answers shown in UMP's cancel step, mapped to the app's reason keys.
function well_cancel_reason_key($text) {
    $map = [
        'too expensive' => 'too_expensive',
        'not using it enough' => 'not_using',
        'missing something i want' => 'missing_something',
        'technical problems' => 'technical',
        'just taking a break' => 'taking_a_break',
        'other' => 'other',
    ];
    $t = strtolower(trim((string) $text));
    if (isset($map[$t])) return ['key' => $map[$t], 'note' => null];
    return $t === '' ? null : ['key' => 'other', 'note' => trim((string) $text)];
}

function well_member_level4_facts($uid) {
    global $wpdb;
    $p = $wpdb->prefix;
    $user = get_userdata($uid);
    if (!$user) return null;
    $lvl = $wpdb->get_row($wpdb->prepare(
        "SELECT start_time, expire_time FROM {$p}ihc_user_levels WHERE user_id = %d AND level_id = 4 ORDER BY id DESC LIMIT 1",
        $uid
    ));
    $gateway = $wpdb->get_var($wpdb->prepare(
        "SELECT m.meta_value FROM {$p}ihc_orders o
           JOIN {$p}ihc_orders_meta m ON m.order_id = o.id AND m.meta_key = 'ihc_payment_type'
          WHERE o.uid = %d AND o.lid = 4 AND o.amount_value > 0 AND o.status = 'Completed'
          ORDER BY o.create_date DESC LIMIT 1",
        $uid
    ));
    $names = ['stripe_connect' => 'Stripe', 'stripe' => 'Stripe', 'paypal' => 'PayPal'];
    return [
        'email' => strtolower($user->user_email),
        'name' => $user->display_name,
        'gateway' => $gateway ? ($names[$gateway] ?? $gateway) : null,
        'started_at' => $lvl ? $lvl->start_time : null,
        'access_until' => $lvl ? $lvl->expire_time : null,
    ];
}

function well_send_membership_event(array $body) {
    if (!defined('WELL_API_KEY') || WELL_API_KEY === '') return;
    wp_remote_post(WELL_MEMBERSHIP_EVENTS_URL, [
        'timeout' => 5,
        'blocking' => false,
        'headers' => ['Content-Type' => 'application/json', 'X-WELL-API-KEY' => WELL_API_KEY],
        'body' => wp_json_encode($body),
    ]);
}

// Member (or admin) cancels Level 4 auto-renew. UMP saves the reason over AJAX just before.
add_action('ihc_action_after_cancel_subscription', function ($uid, $lid) {
    if ((int) $lid !== 4) return;
    $facts = well_member_level4_facts((int) $uid);
    if (!$facts) return;
    global $wpdb;
    $reason = $wpdb->get_var($wpdb->prepare(
        "SELECT reason FROM {$wpdb->prefix}ihc_reason_for_cancel_delete_levels
          WHERE uid = %d AND lid = 4 AND action_date > %d ORDER BY id DESC LIMIT 1",
        (int) $uid, time() - 1800
    ));
    $r = well_cancel_reason_key($reason);
    well_send_membership_event($facts + [
        'kind' => 'cancelled',
        'reason' => $r ? $r['key'] : null,
        'note' => $r ? $r['note'] : null,
    ]);
}, 10, 2);

// A real Level 4 payment. The server only counts it as a join when the member wasn't already paying.
add_action('ihc_payment_completed', function ($uid, $lid, $levelData = null, $order_id = null) {
    if ((int) $lid !== 4) return;
    if ($order_id) {
        global $wpdb;
        $amount = (float) $wpdb->get_var($wpdb->prepare("SELECT amount_value FROM {$wpdb->prefix}ihc_orders WHERE id = %d", (int) $order_id));
        if ($amount <= 0) return;
    }
    $facts = well_member_level4_facts((int) $uid);
    if ($facts) well_send_membership_event($facts + ['kind' => 'joined']);
}, 10, 4);
