/**
 * Brevo (formerly Sendinblue) integration for the WELL Collective.
 *
 * Two responsibilities:
 *   1. When a free trial starts, add the contact to the "App Free Trial"
 *      list in Brevo. Loretta can attach any welcome automation she likes
 *      to that list in the Brevo dashboard.
 *   2. When a trial expires (called by the daily scheduler), send a
 *      personalised win-back transactional email from Loretta encouraging
 *      the member to join the full community.
 *
 * Required env var: BREVO_API_KEY
 * Optional env var: BREVO_SENDER_EMAIL  (defaults to loretta@lorettabates.com)
 */

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_BASE = "https://api.brevo.com/v3";
const SENDER_NAME = "Loretta Bates";
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "loretta@lorettabates.com";
const TRIAL_LIST_NAME = "App Free Trial";

function brevoHeaders(): Record<string, string> {
  return {
    "api-key": BREVO_API_KEY!,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Cached list ID so we only look it up once per process lifetime.
let trialListIdCache: number | null = null;

async function getTrialListId(): Promise<number> {
  if (trialListIdCache !== null) return trialListIdCache;

  // Search existing lists for our list name.
  const res = await fetch(`${BREVO_BASE}/contacts/lists?limit=50`, {
    headers: brevoHeaders(),
  });
  const data = (await res.json()) as { lists?: { id: number; name: string }[] };

  const existing = data.lists?.find((l) => l.name === TRIAL_LIST_NAME);
  if (existing) {
    trialListIdCache = existing.id;
    return existing.id;
  }

  // Create the list if it doesn't exist yet.
  const createRes = await fetch(`${BREVO_BASE}/contacts/lists`, {
    method: "POST",
    headers: brevoHeaders(),
    body: JSON.stringify({ name: TRIAL_LIST_NAME, folderId: 1 }),
  });
  const created = (await createRes.json()) as { id: number };
  console.log(`[BREVO] Created "${TRIAL_LIST_NAME}" list with id ${created.id}`);
  trialListIdCache = created.id;
  return created.id;
}

/**
 * Upserts the contact in Brevo and adds them to the "App Free Trial" list.
 * Safe to call on re-entry (updateEnabled: true) — existing contacts are
 * updated, not duplicated.  Silently skips if BREVO_API_KEY is not set.
 */
export async function addTrialContactToBrevo(
  email: string,
  name: string,
  trialEndsAt: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping contact sync");
    return;
  }

  try {
    const listId = await getTrialListId();
    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ") || "";

    const res = await fetch(`${BREVO_BASE}/contacts`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: firstName,
          LASTNAME: lastName,
          TRIAL_ENDS: trialEndsAt,
        },
        listIds: [listId],
        updateEnabled: true,
      }),
    });

    if (res.ok || res.status === 204) {
      console.log(`[BREVO] Added ${email} to "${TRIAL_LIST_NAME}"`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to add contact (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] addTrialContactToBrevo error:", err);
  }
}

/**
 * Sends the post-trial win-back email via Brevo transactional email API.
 * Called once per expired trial by the daily scheduler.
 */
export async function sendTrialExpiredEmail(
  email: string,
  name: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping win-back email");
    return;
  }

  const firstName = name.split(" ")[0];

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>We miss what you had to offer</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:Georgia,serif;color:#e8e8e8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a6fb8,#4db8e8);padding:28px 40px 24px;text-align:center;">
              <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png"
                   alt="WELL Collective by Loretta Bates"
                   width="220"
                   style="display:block;margin:0 auto 12px;max-width:220px;height:auto;" />
              <p style="margin:0;font-family:Georgia,serif;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:bold;color:#ffffff;font-family:Georgia,serif;">We miss what you had to offer</p>
              <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hi ${firstName},</p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                I've been thinking about you. Your trial week in the WELL Collective has come to an end, and I just want you to know — it really meant a lot to me that you showed up.
              </p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                There's something I truly believe with everything in me: <strong style="color:#4db8e8;">you only get out what you give.</strong> The people who are transforming by showing up for their workouts, leaning into the weekly themes, encouraging one another in the forums — they are not doing it because it's easy. They're doing it because they decided to give it their whole selves.
              </p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                That's what the WELL Collective is! It is not just an app — it is a place where people who are choosing to take care of themselves come together every single day. And there is a place in it for <em>you</em>.
              </p>

              <!-- Pull quote -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
                <tr>
                  <td style="border-left:3px solid #4db8e8;padding:16px 20px;background:#0a1520;border-radius:0 8px 8px 0;">
                    <p style="margin:0;font-size:16px;font-style:italic;color:#4db8e8;line-height:1.6;">
                      "The community is here. The classes are here. The inspiration is here! It is all waiting for you to pour yourself into it and watch it pour right back."
                    </p>
                    <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">— Loretta</p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                Come back. Join us as a full member. Come to the Tuesday livestream. Post in the Community. Cheer on a fellow member. Start a streak. You might be surprised what happens when you give this community everything you've got.
              </p>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="https://lorettabates.com/well-collective"
                       style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:50px;letter-spacing:0.5px;">
                      Join the WELL Collective →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #1e2a3a;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">
                With love and belief in you,
              </p>
              <p style="margin:0;font-size:14px;font-weight:bold;color:#c8cdd6;">Loretta Bates</p>
              <p style="margin:12px 0 0;font-size:11px;color:#4b5563;">
                You're receiving this because you started a free trial in the WELL Collective app.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `We miss what you had to offer

Hi ${firstName},

I've been thinking about you. Your trial week in the WELL Collective has come to an end, and I just want you to know — it really meant a lot to me that you showed up.

There's something I truly believe: you only get out what you give. The people who are transforming by showing up for their workouts, leaning into the weekly themes, encouraging one another in the forums — they are not doing it because it's easy. They're doing it because they decided to give it their whole selves.

That's what the WELL Collective is! It is not just an app — it is a place where people who are choosing to take care of themselves come together every single day.

The community is here. The classes are here. The inspiration is here! It is all waiting for you to pour yourself into it and watch it pour right back.

Come back. Join us as a full member. Come to the Tuesday livestream. Post in the Community. Start a streak. You might be surprised what happens when you give this community everything you've got.

Join the WELL Collective: https://lorettabates.com/well-collective

With love and belief in you,
Loretta Bates`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email, name }],
        subject: `We miss what you had to offer!`,
        htmlContent,
        textContent,
      }),
    });

    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Win-back email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to send win-back email (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendTrialExpiredEmail error:", err);
  }
}
