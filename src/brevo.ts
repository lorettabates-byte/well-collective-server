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
const WELL_SENDER_EMAIL = "well@lorettabates.com";
const TRIAL_LIST_NAME = "App Free Trial";
const TRIAL_COMPLETED_LIST_NAME = "App Trial Completed";
const TRIAL_RESUMED_LIST_NAME = "App Trial Resumed";

function brevoHeaders(): Record<string, string> {
  return {
    "api-key": BREVO_API_KEY!,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Cache list IDs so we only look them up once per process lifetime.
const listIdCache = new Map<string, number>();

async function findOrCreateList(name: string): Promise<number> {
  if (listIdCache.has(name)) return listIdCache.get(name)!;

  // Paginate through ALL lists (account has 291+, limit=50 misses most).
  let offset = 0;
  const limit = 50;
  while (true) {
    const res = await fetch(`${BREVO_BASE}/contacts/lists?limit=${limit}&offset=${offset}`, {
      headers: brevoHeaders(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[BREVO] lists fetch failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { lists?: { id: number; name: string }[]; count?: number };
    const found = data.lists?.find((l) => l.name === name);
    if (found) {
      listIdCache.set(name, found.id);
      return found.id;
    }
    const total = data.count ?? 0;
    offset += limit;
    if (offset >= total || !data.lists?.length) break;
  }

  // List doesn't exist — create it.
  const createRes = await fetch(`${BREVO_BASE}/contacts/lists`, {
    method: "POST",
    headers: brevoHeaders(),
    body: JSON.stringify({ name, folderId: 1 }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`[BREVO] list create failed (${createRes.status}): ${body}`);
  }
  const created = (await createRes.json()) as { id: number };
  console.log(`[BREVO] Created list "${name}" with id ${created.id}`);
  listIdCache.set(name, created.id);
  return created.id;
}

async function removeContactFromList(email: string, listName: string): Promise<void> {
  try {
    const listId = listIdCache.get(listName);
    if (!listId) return; // List hasn't been loaded yet — skip silently
    await fetch(`${BREVO_BASE}/contacts/lists/${listId}/contacts/remove`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({ emails: [email] }),
    });
  } catch (err) {
    console.error(`[BREVO] removeContactFromList error for ${email}:`, err);
  }
}

/**
 * Moves a contact from "App Free Trial" → "App Trial Completed" when their
 * trial expires. Removes them from the active-trial list automatically.
 */
export async function moveTrialContactToCompleted(
  email: string,
  name: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.error("[BREVO] ❌ BREVO_API_KEY is not set — Brevo list sync is disabled. Add it to Railway environment variables.");
    return;
  }
  try {
    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ") || "";
    const completedListId = await findOrCreateList(TRIAL_COMPLETED_LIST_NAME);

    // Add to "App Trial Completed"
    const res = await fetch(`${BREVO_BASE}/contacts`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        email,
        attributes: { FIRSTNAME: firstName, LASTNAME: lastName },
        listIds: [completedListId],
        updateEnabled: true,
      }),
    });
    if (res.ok || res.status === 204) {
      console.log(`[BREVO] Moved ${email} → "${TRIAL_COMPLETED_LIST_NAME}"`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to add to completed list (${res.status}): ${err}`);
    }

    // Remove from "App Free Trial"
    await removeContactFromList(email, TRIAL_LIST_NAME);
  } catch (err) {
    console.error("[BREVO] moveTrialContactToCompleted error:", err);
  }
}

/** @deprecated Use moveTrialContactToCompleted when trial expires */
export async function addCompletedTrialContactToBrevo(
  email: string,
  name: string
): Promise<void> {
  return moveTrialContactToCompleted(email, name);
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
    console.error("[BREVO] ❌ BREVO_API_KEY is not set — Brevo list sync is disabled. Add it to Railway environment variables.");
    return;
  }

  try {
    const listId = await findOrCreateList(TRIAL_LIST_NAME);
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
 * Re-adds a contact to "App Free Trial" and "App Trial Resumed" when their
 * lapsed short trial is automatically extended to the full 30 days.
 */
export async function addResumedTrialContactToBrevo(
  email: string,
  name: string,
  trialEndsAt: string
): Promise<void> {
  if (!BREVO_API_KEY) return;
  try {
    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ") || "";
    const [trialListId, resumedListId] = await Promise.all([
      findOrCreateList(TRIAL_LIST_NAME),
      findOrCreateList(TRIAL_RESUMED_LIST_NAME),
    ]);
    await fetch(`${BREVO_BASE}/contacts`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        email,
        attributes: { FIRSTNAME: firstName, LASTNAME: lastName, TRIAL_ENDS: trialEndsAt },
        listIds: [trialListId, resumedListId],
        updateEnabled: true,
      }),
    });
    console.log(`[BREVO] Resumed trial contact ${email} → "${TRIAL_LIST_NAME}" + "${TRIAL_RESUMED_LIST_NAME}"`);
  } catch (err) {
    console.error("[BREVO] addResumedTrialContactToBrevo error:", err);
  }
}

/**
 * Sends an immediate welcome email when a member starts their free trial for the first time.
 * Warm and brief — the day-3 email handles the full feature tour.
 */
export async function sendWelcomeEmail(
  email: string,
  name: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping welcome email");
    return;
  }

  const firstName = name.split(" ")[0];

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Welcome to WELL with Loretta!</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8e8e8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e1a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a6fb8,#4db8e8);padding:32px 40px 28px;text-align:center;">
              <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png"
                   alt="WELL with Loretta"
                   width="200"
                   style="display:block;margin:0 auto 10px;max-width:200px;height:auto;" />
              <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#c8e8f8;letter-spacing:1.5px;text-transform:uppercase;">by Loretta Bates</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 36px;">
              <p style="margin:0 0 20px;font-size:22px;font-weight:bold;color:#ffffff;line-height:1.3;">Welcome, ${firstName}!</p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#c8cdd6;">
                I am so glad you are here. Your 30-day free trial is officially active and everything inside the WELL with Loretta App is yours to explore.
              </p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#c8cdd6;">
                Live fitness classes, breathwork, meal plans, a curated playlist, and a community of people on the same journey — it is all waiting for you. And every time you show up, you earn points in the <strong style="color:#4db8e8;">WELL Cup</strong>, where daily and monthly winners take home real prizes.
              </p>

              <p style="margin:0 0 32px;font-size:15px;line-height:1.75;color:#c8cdd6;">
                Start by opening the app and completing your profile. Then come say hello in the Community tab — I would love to see you there.
              </p>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
                <tr>
                  <td align="center">
                    <a href="https://app.lorettabates.com"
                       style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 44px;border-radius:50px;letter-spacing:0.5px;">
                      Open the App
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:15px;line-height:1.75;color:#c8cdd6;">
                With love,<br />
                <strong style="color:#e8e8e8;">Loretta</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid #1e2a3a;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4b5563;line-height:1.6;">
                You're receiving this because you started a free trial at the WELL with Loretta App.<br />
                Questions? Reply to this email anytime.
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

  const textContent = `Welcome, ${firstName}!

I am so glad you are here. Your 30-day free trial is officially active and everything inside the WELL with Loretta App is yours to explore.

Live fitness classes, breathwork, meal plans, a curated playlist, and a community of people on the same journey — it is all waiting for you. And every time you show up, you earn points in the WELL Cup, where daily and monthly winners take home real prizes.

Start by opening the app and completing your profile. Then come say hello in the Community tab.

Open the App: https://app.lorettabates.com

With love,
Loretta`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: WELL_SENDER_EMAIL },
        to: [{ email, name }],
        subject: `Welcome, ${firstName}! Your 30-day trial starts now.`,
        htmlContent,
        textContent,
      }),
    });

    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Welcome email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to send welcome email (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendWelcomeEmail error:", err);
  }
}

/**
 * Sends the day-3 mid-trial email via Brevo transactional email API.
 * Called by the daily scheduler for members whose trial started exactly 3 days ago.
 */
// Kept as alias so existing scheduler call sites don't break
export const sendMidTrialEmail = sendDay3Email;

export async function sendDay3Email(
  email: string,
  name: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping day-3 email");
    return;
  }

  const firstName = name.split(" ")[0];

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>You're 3 days in — here's what you might be missing!</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Poppins',Arial,sans-serif;color:#e8e8e8;">
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
              <p style="margin:0;font-family:'Poppins',Arial,sans-serif;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hey ${firstName},</p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                You've been a part of the WELL Collective for 3 days now, and I just want to make sure you're getting the most out of every single day!
              </p>

              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                Here are the features I don't want you to miss:
              </p>

              <!-- Feature: WELL Cup -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🏆 The WELL Cup</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">
                      Everything you do inside the app earns you points: opening the app, logging sleep, completing a workout, listening to music, attending a live event, even accepting a daily challenge! The top point-earner each day wins the WELL Cup. It's our way of celebrating you for showing up. The Monthly Cup Winner gets a <strong style="color:#e8e8e8;">FREE month of the WELL Collective</strong>, and the WELL CROWN winner (for the year) receives a <strong style="color:#e8e8e8;">FREE WELL ESCAPE!</strong>
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Feature: Live Classes -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🎥 Live Classes + Video Library</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">
                      New classes drop weekly! Breathwork, strength training, stretching, cardio, and more. Can't make it live? Every class is saved in the video library so you can work out on your schedule, not mine.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Feature: Nutrition -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🥗 Nutrition</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">
                      A new recipe is waiting for you every single day. Add it to your weekly meal plan, and the app will automatically build your shopping list. You can also log your meals, track nutrition info, and add your own items to the list manually.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Feature: Music -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🎵 Music</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">
                      We curated a full playlist just for your encouragement and wellness moments. Browse by category to find the right vibe, or tap the heart to save songs to your own personal Favorites playlist.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Feature: Events -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr>
                  <td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">📅 Events</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">
                      Workshops, livestreams, and WELL Escapes are all in one place. Click <strong style="color:#e8e8e8;">Going</strong> on any event and points will be automatically added to your account after the event finishes.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Feature: Community -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">💬 Community</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">
                      You don't have to do this alone. The WELL Collective community is inside the app! Be sure to post, comment, share wins, and connect with people who are on the same journey.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                You are a vital part of this community, and it needs what you have to offer!
              </p>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="https://app.lorettabates.com"
                       style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:50px;letter-spacing:0.5px;">
                      Open the App →
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
                With love,
              </p>
              <p style="margin:0;font-size:14px;font-weight:bold;color:#c8cdd6;">Loretta</p>
              <p style="margin:12px 0 0;font-size:11px;color:#4b5563;">
                You're receiving this because you're a member of the WELL Collective app. Questions? Reply to this email anytime.
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

  const textContent = `Hey ${firstName},

You've been a part of the WELL Collective for 3 days now, and I just want to make sure you're getting the most out of every single day!

Here are the features I don't want you to miss:

🏆 THE WELL CUP
Everything you do inside the app earns you points: opening the app, logging sleep, completing a workout, listening to music, attending a live event, even accepting a daily challenge! The top point-earner each day wins the WELL Cup. It's our way of celebrating you for showing up. The Monthly Cup Winner gets a FREE month of the WELL Collective, and the WELL CROWN winner (for the year) receives a FREE WELL ESCAPE!

🎥 LIVE CLASSES + VIDEO LIBRARY
New classes drop weekly! Breathwork, strength training, stretching, cardio, and more. Can't make it live? Every class is saved in the video library so you can work out on your schedule, not mine.

🥗 NUTRITION
A new recipe is waiting for you every single day. Add it to your weekly meal plan, and the app will automatically build your shopping list. You can also log your meals, track nutrition info, and add your own items to the list manually.

🎵 MUSIC
We curated a full playlist just for your encouragement and wellness moments. Browse by category to find the right vibe, or tap the heart to save songs to your own personal Favorites playlist.

📅 EVENTS
Workshops, livestreams, and WELL Escapes are all in one place. Click Going on any event and points will be automatically added to your account after the event finishes.

💬 COMMUNITY
You don't have to do this alone. The WELL Collective community is inside the app! Be sure to post, comment, share wins, and connect with people who are on the same journey.

You are a vital part of this community, and it needs what you have to offer!

Open the App: https://app.lorettabates.com

With love,
Loretta

You're receiving this because you're a member of the WELL Collective app. Questions? Reply to this email anytime.`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: WELL_SENDER_EMAIL },
        to: [{ email, name }],
        subject: `You're 3 days in — here's what you might be missing! ✨`,
        htmlContent,
        textContent,
      }),
    });

    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Day-3 email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to send day-3 email (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendDay3Email error:", err);
  }
}

/**
 * Sends the week-1 "are you taking advantage of everything?" email to referred
 * members (30-day trial). Called by the daily scheduler around day 7.
 */
export async function sendReferralWeek1Email(
  email: string,
  name: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping referral week-1 email");
    return;
  }

  const firstName = name.split(" ")[0];

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>One week in — are you getting everything out of this?</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Poppins',Arial,sans-serif;color:#e8e8e8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
          <tr>
            <td style="background:linear-gradient(135deg,#1a6fb8,#4db8e8);padding:28px 40px 24px;text-align:center;">
              <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png" alt="WELL Collective by Loretta Bates" width="220" style="display:block;margin:0 auto 12px;max-width:220px;height:auto;" />
              <p style="margin:0;font-family:'Poppins',Arial,sans-serif;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hey ${firstName},</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">You've been inside the WELL Collective for a week now, and I am <em>so</em> glad you're here! A friend vouched for you, and that means the world to me — because this community is built on exactly that kind of connection!</p>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">You still have three weeks left on your trial, and I want to make sure you are getting the absolute most out of every single day. Here are the things I don't want you to miss:</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr><td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                  <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🏆 The WELL Cup</p>
                  <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">Everything in the app earns you points — opening the app, logging sleep, completing a workout, listening to music, attending events, even accepting a daily challenge. Monthly winners get a <strong style="color:#e8e8e8;">free month of WELL Collective</strong>, and the year-end WELL Crown winner receives a <strong style="color:#e8e8e8;">free WELL ESCAPE retreat!</strong></p>
                </td></tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr><td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                  <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🎥 Live Classes + Video Library</p>
                  <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">New classes drop every week — breathwork, strength, cardio, stretching, and more. Miss it live? It's saved in the video library for whenever you're ready.</p>
                </td></tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                <tr><td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                  <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">🥗 Nutrition</p>
                  <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">A new recipe every day, built-in meal planner, automatic shopping list. Be sure to add your meals for information on your energy balance — and all while earning points!</p>
                </td></tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr><td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
                  <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#4db8e8;">💬 Community</p>
                  <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">Post a win, leave an encouraging comment, or just say hi. Your voice matters here — and you might be exactly what someone else needs to hear today.</p>
                </td></tr>
              </table>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">You are here for a reason. I believe that. Now let's make these 30 days count!</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td align="center">
                  <a href="https://lorettabates.com/videolibrary.lorettabates.com/subscription-plan/" style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:50px;letter-spacing:0.5px;">Join the WELL Collective →</a>
                </td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #1e2a3a;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">With love,</p>
              <p style="margin:0;font-size:14px;font-weight:bold;color:#c8cdd6;">Loretta</p>
              <p style="margin:12px 0 0;font-size:11px;color:#4b5563;">You're receiving this because you joined the WELL Collective app through a friend's referral. Questions? Reply to this email anytime.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `Hey ${firstName},

You've been inside the WELL Collective for a week now, and I am so glad you're here! A friend vouched for you, and that means the world to me — because this community is built on exactly that kind of connection!

You still have three weeks left on your trial — here's what I don't want you to miss:

🏆 THE WELL CUP — earn points for everything in the app. Monthly winners get a free month; the year-end WELL Crown winner gets a free WELL ESCAPE!
🎥 LIVE CLASSES + VIDEO LIBRARY — new classes weekly, all saved in the library.
🥗 NUTRITION — daily recipes, meal planner, automatic shopping list. Be sure to add your meals for information on your energy balance and all while earning points!
💬 COMMUNITY — post a win, cheer someone on, connect with people on the same journey.

You are here for a reason. Let's make these 30 days count!

Join the WELL Collective: https://lorettabates.com/videolibrary.lorettabates.com/subscription-plan/

With love,
Loretta`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: WELL_SENDER_EMAIL },
        to: [{ email, name }],
        subject: `One week in — are you taking advantage of everything? ✨`,
        htmlContent,
        textContent,
      }),
    });
    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Referral week-1 email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to send referral week-1 email (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendReferralWeek1Email error:", err);
  }
}

/**
 * Sends the post-trial "we miss you" email to referred members whose 30-day
 * trial has ended and who haven't converted to a paid membership.
 */
export async function sendReferralWinbackEmail(
  email: string,
  name: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping referral winback email");
    return;
  }

  const firstName = name.split(" ")[0];

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>We miss you — and we mean it</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Poppins',Arial,sans-serif;color:#e8e8e8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
          <tr>
            <td style="background:linear-gradient(135deg,#1a6fb8,#4db8e8);padding:28px 40px 24px;text-align:center;">
              <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png" alt="WELL Collective by Loretta Bates" width="220" style="display:block;margin:0 auto 12px;max-width:220px;height:auto;" />
              <p style="margin:0;font-family:'Poppins',Arial,sans-serif;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:bold;color:#ffffff;font-family:'Poppins',Arial,sans-serif;">We miss you — and we mean it</p>
              <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hi ${firstName},</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">Your trial in the WELL Collective has come to an end, and I want you to know that your presence in this community genuinely mattered. The fact that a friend thought of you and wanted you here says everything about who you are.</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">I truly believe that the people who are transforming inside the WELL Collective are the ones who decide that <strong style="color:#4db8e8;">they are worth showing up for. Every.Single.Day.</strong></p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
                <tr>
                  <td style="border-left:3px solid #4db8e8;padding:16px 20px;background:#0a1520;border-radius:0 8px 8px 0;">
                    <p style="margin:0;font-size:16px;font-style:italic;color:#4db8e8;line-height:1.6;">"The community is here. The classes are here. The inspiration is here. The only thing missing is you."</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">${firstName}, come back as a full member. Join us for the Tuesday livestream. Post in the Community. Cheer someone on. Start a streak. Let's do this together!</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td align="center">
                  <a href="https://lorettabates.com/videolibrary.lorettabates.com/subscription-plan/" style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:50px;letter-spacing:0.5px;">Join the WELL Collective →</a>
                </td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #1e2a3a;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">With love and belief in you,</p>
              <p style="margin:0;font-size:14px;font-weight:bold;color:#c8cdd6;">Loretta Bates</p>
              <p style="margin:12px 0 0;font-size:11px;color:#4b5563;">You're receiving this because you joined the WELL Collective app through a friend's referral.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `We miss you — and we mean it

Hi ${firstName},

Your trial in the WELL Collective has come to an end, and I want you to know that your presence in this community genuinely mattered. The fact that a friend thought of you and wanted you here says everything about who you are.

I truly believe that the people who are transforming inside the WELL Collective are the ones who decide that they are worth showing up for. Every.Single.Day.

"The community is here. The classes are here. The inspiration is here. The only thing missing is you."

${firstName}, come back as a full member. Join us for the Tuesday livestream. Post in the Community. Cheer someone on. Start a streak. Let's do this together!

Join the WELL Collective: https://lorettabates.com/videolibrary.lorettabates.com/subscription-plan/

With love and belief in you,
Loretta Bates`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email, name }],
        subject: `We miss you — and we mean it`,
        htmlContent,
        textContent,
      }),
    });
    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Referral winback email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Failed to send referral winback email (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendReferralWinbackEmail error:", err);
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
<style>@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Poppins',Arial,sans-serif;color:#e8e8e8;">
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
              <p style="margin:0;font-family:'Poppins',Arial,sans-serif;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:bold;color:#ffffff;font-family:'Poppins',Arial,sans-serif;">We miss what you had to offer</p>
              <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hi ${firstName},</p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                I've been thinking about you. Your trial week in the WELL Collective has come to an end, and I just want you to know that it really meant a lot to me that you showed up!
              </p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                There's something I truly believe with everything in me: <strong style="color:#4db8e8;">you only get out what you give.</strong> The people who are transforming by showing up for their workouts, leaning into the weekly themes, encouraging one another in the forums, they are not doing it because it's easy! They're doing it because they decided to give it their whole selves.
              </p>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
                That is what the WELL Collective is! It is a place where people who are choosing to take care of themselves come together every single day and there is definitely a place in it for <em>you</em>!
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
                    <a href="https://lorettabates.com/videolibrary.lorettabates.com/subscription-plan/"
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

I've been thinking about you. Your trial week in the WELL Collective has come to an end, and I just want you to know that it really meant a lot to me that you showed up!

There's something I truly believe with everything in me: you only get out what you give. The people who are transforming by showing up for their workouts, leaning into the weekly themes, encouraging one another in the forums, they are not doing it because it's easy! They're doing it because they decided to give it their whole selves.

That is what the WELL Collective is! It is a place where people who are choosing to take care of themselves come together every single day and there is definitely a place in it for you!

"The community is here. The classes are here. The inspiration is here! It is all waiting for you to pour yourself into it and watch it pour right back."
— Loretta

Come back. Join us as a full member. Come to the Tuesday livestream. Post in the Community. Cheer on a fellow member. Start a streak. You might be surprised what happens when you give this community everything you've got.

Join the WELL Collective: https://lorettabates.com/videolibrary.lorettabates.com/subscription-plan/

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

/**
 * Sent to active WELL Collective members who are NOT yet on the myWELL app.
 * Reminds them the app is included in their membership and encourages them to download it.
 */
function svgIcon(paths: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4db8e8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const ICON_GOAL     = svgIcon('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>');
const ICON_PEOPLE   = svgIcon('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>');
const ICON_GRID     = svgIcon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>');
const ICON_TROPHY   = svgIcon('<path d="M6 9H4a2 2 0 0 1-2-2V5h4m14 4h2a2 2 0 0 0 2-2V5h-4M4 5h16v4a8 8 0 0 1-16 0V5z"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/>');
const ICON_SLIDERS  = svgIcon('<line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="12" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="18" r="2"/>');

function iconRow(iconDataUri: string, label: string, body: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
    <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr>
      <td style="width:30px;padding-right:10px;vertical-align:middle;"><img src="${iconDataUri}" width="22" height="22" alt="" style="display:block;" /></td>
      <td style="vertical-align:middle;"><p style="margin:0;font-size:16px;font-weight:bold;color:#4db8e8;">${label}</p></td>
    </tr></table>
    <p style="margin:0;font-size:14px;line-height:1.7;color:#c8cdd6;">${body}</p>
  </td></tr></table>`;
}

export async function sendAppInviteEmail(email: string, name: string): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping app invite email");
    return;
  }
  const firstName = name.split(" ")[0];
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your membership includes this - have you tried it yet?</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,sans-serif;color:#e8e8e8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
        <tr>
          <td style="background:linear-gradient(135deg,#1a6fb8,#4db8e8);padding:28px 40px 24px;text-align:center;">
            <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png" alt="WELL Collective" width="220" style="display:block;margin:0 auto 12px;max-width:220px;height:auto;" />
            <p style="margin:0;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hey ${firstName},</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
              I wanted to reach out personally because I'm so excited about something that's now a part of your WELL Collective membership and I want to make sure you know about it!
            </p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
              The <strong style="color:#ffffff;">WELL with Loretta app</strong> is live, and it is included in your membership at no extra cost. This is where the WELL community is coming together every single day between our live classes and events.
            </p>
            ${iconRow(ICON_GOAL, "Built around your goals", "When you first open the app you'll answer a few simple questions about what you're working toward. The app uses your answers to shape your daily experience, so everything you see is relevant to you and where you are right now.")}
            ${iconRow(ICON_PEOPLE, "Your community, always with you", "Connect with fellow WELL members, build your WELL Tribe, cheer each other on, and stay inspired between live sessions. The community doesn't stop when class ends.")}
            ${iconRow(ICON_GRID, "Everything you need in one place", "Daily inspirations, a new recipe every day, meal planner with shopping list, breathwork, curated music, push notifications for live classes, and your full event calendar.")}
            ${iconRow(ICON_TROPHY, "The WELL Cup", "Everything you do in the app earns points. Daily winner gets recognition, monthly winner gets a <strong style=\"color:#e8e8e8;\">free month</strong>, and the annual WELL Crown winner receives a <strong style=\"color:#e8e8e8;\">free WELL ESCAPE!</strong>")}
            <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">
              <strong style="color:#ffffff;">It is already part of your membership.</strong> All you have to do is show up.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
              <tr><td align="center">
                <a href="https://app.lorettabates.com" style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:50px;letter-spacing:0.5px;">Open the App</a>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 0;">
              <tr><td style="background:#0a1520;border:1px solid #1e2a3a;border-radius:12px;padding:18px 24px;">
                <p style="margin:0 0 10px;font-size:13px;font-weight:bold;color:#e8e8e8;">Add it to your home screen for one-tap access:</p>
                <p style="margin:0 0 6px;font-size:13px;color:#c8cdd6;"><strong style="color:#4db8e8;">iPhone:</strong> Open app.lorettabates.com in Safari, tap the Share icon at the bottom, then tap "Add to Home Screen."</p>
                <p style="margin:0;font-size:13px;color:#c8cdd6;"><strong style="color:#4db8e8;">Android:</strong> Open app.lorettabates.com in Chrome, tap the three-dot menu in the top right, then tap "Add to Home Screen."</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px;border-top:1px solid #1e2a3a;text-align:center;">
            <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">With love,</p>
            <p style="margin:0;font-size:14px;font-weight:bold;color:#c8cdd6;">Loretta</p>
            <p style="margin:12px 0 0;font-size:11px;color:#4b5563;">You're receiving this as a WELL Collective member. Questions? Reply anytime.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  const textContent = `Hey ${firstName},

I wanted to reach out personally because I'm so excited about something that's now a part of your WELL Collective membership and I want to make sure you know about it!

The WELL with Loretta app is live, and it is included in your membership at no extra cost. This is where the WELL community is coming together every single day between our live classes and events.

Built around your goals: When you first open the app you'll answer a few simple questions about what you're working toward. The app uses your answers to shape your daily experience.

Your community, always with you: Connect with fellow WELL members, build your WELL Tribe, cheer each other on, and stay inspired between live sessions.

Everything you need in one place: Daily inspirations, new recipe every day, meal planner with shopping list, breathwork, music, event calendar, and push notifications for live classes.

The WELL Cup: Everything you do earns points. Monthly winner gets a free month, annual WELL Crown winner gets a free WELL ESCAPE!

It is already part of your membership. All you have to do is show up.

Open the app: https://app.lorettabates.com

Add it to your home screen for one-tap access:
- iPhone: Open the link in Safari, tap the Share icon, then "Add to Home Screen."
- Android: Open the link in Chrome, tap the three-dot menu, then "Add to Home Screen."

With love,
Loretta`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: WELL_SENDER_EMAIL },
        to: [{ email, name }],
        subject: `Your membership includes this - have you tried it yet?`,
        htmlContent,
        textContent,
      }),
    });
    if (res.ok || res.status === 201) {
      console.log(`[BREVO] App invite email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] App invite email failed (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendAppInviteEmail error:", err);
  }
}

/**
 * Sent to lapsed (formerly active, now cancelled/expired) WELL Collective members.
 * Includes Loretta's referral code so they get a free trial month when they return.
 */
export async function sendMemberWinbackEmail(
  email: string,
  name: string,
  referralCode: string
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping member winback email");
    return;
  }
  const firstName = name.split(" ")[0];
  const trialUrl = `https://app.lorettabates.com?ref=${encodeURIComponent(referralCode)}`;
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>You're invited back - one month on me</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,sans-serif;color:#e8e8e8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border:1px solid #1e2a3a;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
        <tr>
          <td style="background:linear-gradient(135deg,#1a6fb8,#4db8e8);padding:28px 40px 24px;text-align:center;">
            <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png" alt="WELL Collective" width="220" style="display:block;margin:0 auto 12px;max-width:220px;height:auto;" />
            <p style="margin:0;font-size:13px;color:#c8e8f8;letter-spacing:1px;text-transform:uppercase;">by Loretta Bates</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:bold;color:#ffffff;">You're invited back - one month on me</p>
            <p style="margin:0 0 24px;font-size:18px;color:#e8e8e8;">Hi ${firstName},</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
              I've been thinking about you. You were a part of the WELL Collective, and that means something. Wherever life took you since, I want you to know the door is always open here.
            </p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#c8cdd6;">
              A lot has changed in the WELL Collective, and I would love for you to experience it. So I want to offer you something: <strong style="color:#4db8e8;">come back for one month, completely free, on me.</strong>
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
              <tr>
                <td style="background:linear-gradient(135deg,#0a1520,#0d1e30);border:2px solid #4db8e8;border-radius:12px;padding:24px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Your free month code</p>
                  <p style="margin:0 0 16px;font-size:28px;font-weight:bold;color:#4db8e8;letter-spacing:3px;">${referralCode}</p>
                  <p style="margin:0;font-size:12px;color:#6b7280;">Use at signup for a free 30-day trial</p>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#c8cdd6;"><strong style="color:#e8e8e8;">What's new since you've been gone:</strong></p>
            ${iconRow(ICON_SLIDERS, "Your wellness, customized for you", `The <strong style="color:#ffffff;">WELL with Loretta app</strong> is not a one-size-fits-all experience. When you join, you set your wellness goals, and the app shapes itself around you. You choose which sections live on your home screen. Your push notifications are tailored to what matters to you, whether that's class reminders, daily inspiration, or your WELL Cup progress. It's your wellness journey, built the way you need it.`)}
            ${iconRow(ICON_TROPHY, "The WELL Cup", `Daily + monthly prizes including <strong style="color:#e8e8e8;">free months</strong> and <strong style="color:#e8e8e8;">WELL ESCAPES</strong>, just for showing up.`)}
            ${iconRow(ICON_GRID, "Everything in one place", "New recipes, breathwork sessions, curated music, a live community forum, and a WELL Tribe of members showing up for themselves every single day.")}
            <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#c8cdd6;">
              You showed up before, and that matters. I believe you're ready to show up again. Let's do this together.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
              <tr><td align="center">
                <a href="${trialUrl}" style="display:inline-block;background:linear-gradient(135deg,#1a6fb8,#4db8e8);color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:50px;letter-spacing:0.5px;">Claim My Free Month</a>
              </td></tr>
            </table>
            <p style="margin:0;font-size:13px;color:#6b7280;text-align:center;">Or go directly to <a href="https://app.lorettabates.com" style="color:#4db8e8;">app.lorettabates.com</a> and enter code <strong style="color:#4db8e8;">${referralCode}</strong> at signup</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px;border-top:1px solid #1e2a3a;text-align:center;">
            <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">With love and belief in you,</p>
            <p style="margin:0;font-size:14px;font-weight:bold;color:#c8cdd6;">Loretta Bates</p>
            <p style="margin:12px 0 0;font-size:11px;color:#4b5563;">You're receiving this because you were previously a WELL Collective member. To stop receiving emails, reply with "unsubscribe."</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  const textContent = `You're invited back - one month on me

Hi ${firstName},

I've been thinking about you. You were a part of the WELL Collective, and that means something. Wherever life took you since, I want you to know the door is always open here.

A lot has changed in the WELL Collective, and I would love for you to experience it. So I want to offer you something: come back for one month, completely free, on me.

YOUR FREE MONTH CODE: ${referralCode}
Use at signup: ${trialUrl}

What's new since you've been gone:

Your wellness, customized for you: The WELL with Loretta app is not a one-size-fits-all experience. You set your goals, choose which sections live on your home screen, and your push notifications are tailored to what matters to you.

The WELL Cup: Daily + monthly prizes including free months and WELL ESCAPES, just for showing up.

Everything in one place: New recipes, breathwork sessions, curated music, a live community forum, and a WELL Tribe of members showing up for themselves every single day.

You showed up before, and that matters. I believe you're ready to show up again. Let's do this together.

Claim My Free Month: ${trialUrl}

With love and belief in you,
Loretta Bates`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: WELL_SENDER_EMAIL },
        to: [{ email, name }],
        subject: `You're invited back - one month on me`,
        htmlContent,
        textContent,
      }),
    });
    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Member winback email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Member winback email failed (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendMemberWinbackEmail error:", err);
  }
}

/**
 * Sends a win-back email to members whose original trial was < 30 days,
 * inviting them to return and claim the remainder of their 30-day trial.
 * The link goes directly to the app — the server auto-detects and extends
 * the trial when they log back in.
 */
export async function sendTrialResumeWinbackEmail(
  email: string,
  name: string,
  originalDaysUsed: number
): Promise<void> {
  if (!BREVO_API_KEY) {
    console.warn("[BREVO] BREVO_API_KEY not set — skipping trial resume winback email");
    return;
  }
  const firstName = name.split(" ")[0];
  const remainingDays = 30 - originalDaysUsed;
  const appUrl = "https://app.lorettabates.com";
  const logoUrl = "https://lorettabates.com/videolibrary.lorettabates.com/wp-content/uploads/2025/04/WELL-2048-x-2048-px.png";

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your ${remainingDays} days are still waiting</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,400;1,500&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
</style>
</head>
<body style="margin:0;padding:0;background:#020812;font-family:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;color:#f3f8fc;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#020812;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#050b14;border:1px solid rgba(132,216,253,0.1);border-radius:16px;overflow:hidden;max-width:600px;width:100%;">

      <!-- Logo header -->
      <tr>
        <td style="padding:28px 40px 24px;text-align:center;border-bottom:1px solid rgba(132,216,253,0.08);">
          <img src="${logoUrl}" alt="WELL Collective" width="56" height="56" style="display:inline-block;border-radius:12px;width:56px;height:56px;" />
        </td>
      </tr>

      <!-- Hero -->
      <tr>
        <td style="padding:48px 40px 12px;text-align:center;">
          <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#84d8fd;">WELL with Loretta App</p>
          <h1 style="margin:0 0 20px;font-family:'Cormorant Garamond',Georgia,serif;font-size:44px;font-style:italic;font-weight:500;line-height:1.1;color:#f3f8fc;">You still have ${remainingDays}&nbsp;days left.</h1>
          <p style="margin:0;font-size:15px;line-height:1.7;color:#8da4bd;max-width:440px;display:inline-block;">
            Hi ${firstName}, when you tried the app your trial was set to 7 days. We have extended it. The full trial is now 30 days, and you have <strong style="color:#c8e8f8;">${remainingDays} days</strong> that you never got to use.
          </p>
        </td>
      </tr>

      <!-- What you missed -->
      <tr>
        <td style="padding:32px 40px 8px;">
          <p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#5e7793;text-align:center;">What is waiting for you</p>

          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:14px 20px;background:#0d1826;border:1px solid rgba(132,216,253,0.08);border-radius:12px;margin-bottom:10px;display:block;">
                <p style="margin:0 0 4px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:600;color:#f3f8fc;">Daily coaching from me, personally</p>
                <p style="margin:0;font-size:13px;color:#8da4bd;line-height:1.6;">A morning message, an afternoon check-in, and an evening recap sent straight to your phone every single day.</p>
              </td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="10" style="margin-top:10px;">
            <tr>
              <td style="padding:14px 20px;background:#0d1826;border:1px solid rgba(132,216,253,0.08);border-radius:12px;">
                <p style="margin:0 0 4px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:600;color:#f3f8fc;">WELL Cup leaderboard</p>
                <p style="margin:0;font-size:13px;color:#8da4bd;line-height:1.6;">Earn points for every healthy action you take and compete with the community for daily and monthly wins.</p>
              </td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="10" style="margin-top:10px;">
            <tr>
              <td style="padding:14px 20px;background:#0d1826;border:1px solid rgba(132,216,253,0.08);border-radius:12px;">
                <p style="margin:0 0 4px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:600;color:#f3f8fc;">Live events, recipes, and breathwork</p>
                <p style="margin:0;font-size:13px;color:#8da4bd;line-height:1.6;">Guided breathwork, a new healthy recipe every day, live Loretta classes, and retreats reserved for members only.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="padding:36px 40px 20px;text-align:center;">
          <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#01519d 0%,#0191ce 55%,#84d8fd 100%);color:#ffffff;font-family:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:16px 44px;border-radius:100px;letter-spacing:0.02em;">Resume My Trial</a>
          <p style="margin:12px 0 0;font-size:12px;color:#5e7793;">Tap the button, enter your email, and you are back in. No card required.</p>
        </td>
      </tr>

      <!-- Divider -->
      <tr><td style="padding:0 40px;"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(132,216,253,0.15),transparent);"></div></td></tr>

      <!-- Signature -->
      <tr>
        <td style="padding:32px 40px;">
          <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#8da4bd;">I saved your spot because I genuinely believe ${remainingDays} more days inside this community can change how you feel in your body. All it takes is opening the app.</p>
          <p style="margin:0 0 6px;font-size:14px;color:#8da4bd;">With love,</p>
          <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-style:italic;font-weight:500;color:#f3f8fc;">Loretta Bates</p>
          <p style="margin:4px 0 0;font-size:12px;color:#5e7793;">Founder, WELL Collective</p>
        </td>
      </tr>

      <!-- Logo footer -->
      <tr>
        <td style="padding:20px 40px 28px;text-align:center;border-top:1px solid rgba(132,216,253,0.06);">
          <img src="${logoUrl}" alt="WELL Collective" width="40" height="40" style="display:inline-block;border-radius:10px;width:40px;height:40px;margin-bottom:10px;" />
          <p style="margin:0;font-size:11px;color:#3d5266;line-height:1.6;">You received this because you previously trialed the WELL with Loretta App.</p>
          <p style="margin:4px 0 0;font-size:11px;color:#3d5266;"><a href="#" style="color:#5e7793;">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://lorettabates.com" style="color:#5e7793;">lorettabates.com</a></p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  const textContent = `Hi ${firstName},

Your ${remainingDays} days are still waiting.

When you tried the WELL with Loretta App, your trial was 7 days. The trial is now 30 days total, and you have ${remainingDays} days you never used.

Come back and claim them: ${appUrl}

Just open the app, enter your email, and you are back in. No card required.

With love,
Loretta Bates
Founder, WELL Collective`;

  try {
    const res = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: brevoHeaders(),
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: WELL_SENDER_EMAIL },
        to: [{ email, name }],
        subject: `${firstName}, your ${remainingDays} days are still waiting`,
        htmlContent,
        textContent,
      }),
    });
    if (res.ok || res.status === 201) {
      console.log(`[BREVO] Trial resume winback email sent to ${email}`);
    } else {
      const err = await res.text();
      console.error(`[BREVO] Trial resume winback email failed (${res.status}): ${err}`);
    }
  } catch (err) {
    console.error("[BREVO] sendTrialResumeWinbackEmail error:", err);
  }
}
