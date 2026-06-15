<?php
/**
 * WELL Collective - Member login REST endpoint for the mobile app.
 * Verifies a member's username/password directly against WordPress core
 * (bypassing the JWT plugin's Application Passwords requirement) and
 * returns their email + display name on success.
 *
 * Requires the same WELL_API_KEY constant defined in the
 * well/v1/membership-status snippet.
 */

add_action('rest_api_init', function () {
    register_rest_route('well/v1', '/member-login', [
        'methods' => 'POST',
        'callback' => 'well_member_login',
        'permission_callback' => 'well_member_login_permission_check',
    ]);
});

function well_member_login_permission_check(WP_REST_Request $request) {
    $key = $request->get_header('x-well-api-key');
    return !empty($key) && hash_equals(WELL_API_KEY, (string) $key);
}

function well_member_login(WP_REST_Request $request) {
    $username = sanitize_text_field($request->get_param('username'));
    $password = (string) $request->get_param('password');

    if (empty($username) || empty($password)) {
        return new WP_Error('missing_fields', 'Username and password are required.', ['status' => 400]);
    }

    $user = wp_authenticate($username, $password);

    if (is_wp_error($user)) {
        $message = wp_strip_all_tags($user->get_error_message());
        return new WP_Error('invalid_credentials', $message, ['status' => 401]);
    }

    return [
        'email' => $user->user_email,
        'name' => $user->display_name,
    ];
}
