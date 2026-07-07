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
