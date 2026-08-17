<?php
/**
 * WELL Collective - Birthday sync REST endpoint.
 * Called by our server whenever a member saves their birthday in the app.
 * Converts our MM-DD storage format to the M/D/YYYY format UMP expects,
 * then writes it to ihc_birthday user meta so UMP birthday emails fire
 * on the correct day.
 *
 * Requires the same WELL_API_KEY constant defined in membership-status snippet.
 */

add_action('rest_api_init', function () {
    register_rest_route('well/v1', '/update-birthday', [
        'methods' => 'POST',
        'callback' => 'well_update_birthday',
        'permission_callback' => 'well_update_birthday_permission_check',
    ]);
});

function well_update_birthday_permission_check(WP_REST_Request $request) {
    $key = $request->get_header('x-well-api-key');
    return !empty($key) && hash_equals(WELL_API_KEY, (string) $key);
}

function well_update_birthday(WP_REST_Request $request) {
    $email    = sanitize_email($request->get_param('email'));
    $birthday = sanitize_text_field($request->get_param('birthday')); // expects MM-DD

    if (empty($email) || empty($birthday)) {
        return new WP_Error('missing_fields', 'email and birthday are required.', ['status' => 400]);
    }

    // Validate MM-DD format
    if (!preg_match('/^\d{2}-\d{2}$/', $birthday)) {
        return new WP_Error('invalid_format', 'birthday must be MM-DD format.', ['status' => 400]);
    }

    $user = get_user_by('email', $email);
    if (!$user) {
        return new WP_Error('user_not_found', 'No WordPress user found for that email.', ['status' => 404]);
    }

    // Convert MM-DD → M/D/YYYY (UMP stores birthday as m/d/Y in PHP date terms)
    // We use a fixed placeholder year 2000 since UMP only checks month + day.
    list($month, $day) = explode('-', $birthday);
    $formatted = ltrim($month, '0') . '/' . ltrim($day, '0') . '/2000';

    update_user_meta($user->ID, 'ihc_birthday', $formatted);

    return ['ok' => true, 'ihc_birthday' => $formatted];
}
