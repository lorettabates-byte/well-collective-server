import cron from "node-cron";
import { pool } from "./db";
import { sendNotificationToUser } from "./push";
import { createMemberNotification } from "./memberNotifications";

type GoalPlan = "energy" | "weight" | "strength" | "rut" | "stress" | "community";
type NotifTone = "motivation" | "accountability" | "gentle" | "education";
type TimeSlot = "morning" | "afternoon" | "evening";

interface NotifCopy { title: string; body: string }

const GOAL_NOTIFS: Record<GoalPlan, Record<TimeSlot, NotifCopy[]>> = {
  stress: {
    morning: [
      { title: "Start calm, stay calm", body: "Try 5 minutes of breathwork before the day takes over. Your nervous system will thank you." },
      { title: "A calm morning is a gift", body: "Take one slow breath before you check anything. You're in charge of your morning." },
      { title: "Set the tone", body: "Your breathwork session is waiting. 5 minutes now = a calmer day ahead." },
      { title: "Ground yourself first", body: "Before the to-do list — one deep breath. You've got this." },
      { title: "Peace starts here", body: "Good morning. Open WELL for your calm toolkit — even a little breathwork goes a long way." },
      { title: "You deserve a peaceful morning", body: "Try the humming breath or box breathing to ease into your day." },
      { title: "Calm is a practice", body: "Morning breathwork is one of the best things you can do for stress today. Let's go." },
    ],
    afternoon: [
      { title: "Afternoon check-in", body: "Feeling the midday stress? Step away for 3 deep breaths. You'll come back clearer." },
      { title: "Don't forget to breathe", body: "Seriously — when did you last take a full, slow breath? Right now is a great time." },
      { title: "Stress check: 3pm", body: "Notice your shoulders. Unclench your jaw. Take one long exhale. Better?" },
      { title: "Your calm toolkit is open", body: "Feeling overwhelmed? The Calm Toolkit has exactly what you need — right now." },
      { title: "Midday reset", body: "A 5-minute walk or breathwork break will help more than powering through. Promise." },
      { title: "You're doing great", body: "Stress happens. What matters is how you respond. Take a moment for you." },
      { title: "Recharge", body: "Even 2 minutes of quiet breathing can reset your afternoon. Give yourself that." },
    ],
    evening: [
      { title: "Wind down with intention", body: "Tonight's breathwork is ready. Let your body and mind release the day." },
      { title: "Release what you're holding", body: "Log your sleep, do your evening breathwork, and let it go. Tomorrow is fresh." },
      { title: "You made it through", body: "Whatever today brought, you're still here. Log your wellness wins and breathe easy." },
      { title: "Protect your sleep", body: "No screens, a little breathwork, some herbal tea. Your nervous system needs rest." },
      { title: "Gentle wind-down", body: "Try the 4-7-8 breath tonight. It activates your parasympathetic system — aka calm mode." },
      { title: "Exhale the day", body: "Journal for 5 minutes, or just breathe. Either way, give yourself the gift of slowing down." },
      { title: "Sleep is stress medicine", body: "Tonight's goal: 8 hours. Log your sleep in WELL so you can track what restores you most." },
    ],
  },
  energy: {
    morning: [
      { title: "Rise and energize", body: "Good morning! Log breakfast by 9am and take 3 deep breaths before your first meeting." },
      { title: "Your energy starts now", body: "Drink a glass of water, eat protein at breakfast, and feel the difference by noon." },
      { title: "Morning momentum", body: "Even a 10-minute walk before coffee can transform your energy for the whole day." },
      { title: "Fuel up first", body: "Don't skip breakfast — your energy depends on it. Open WELL to log your first meal." },
      { title: "Today's energy forecast: high", body: "Set the intention now. A strong morning creates an energized day." },
      { title: "Wake up and win", body: "Your daily plan is ready. A few intentional moves this morning and you'll feel amazing." },
      { title: "Move to feel alive", body: "Good morning! Movement — even 5 minutes — activates your energy better than a second coffee." },
    ],
    afternoon: [
      { title: "Afternoon energy boost", body: "Skip the second coffee — try a 10-minute walk instead. You'll be surprised how much better you feel." },
      { title: "3pm slump? Let's fix it", body: "Jump up, do 10 jumping jacks, drink some water. Your energy is just waiting to be unlocked." },
      { title: "Hydration check", body: "Have you had enough water today? Dehydration is the #1 hidden cause of afternoon fatigue." },
      { title: "Beat the slump", body: "Swap the afternoon snack for herbal tea and a 5-minute stretch. Energy incoming." },
      { title: "You're not tired — you're under-fueled", body: "Grab a protein-rich snack and take a 5-min walk. WELL Check is waiting for your update." },
      { title: "Midday momentum", body: "Log your steps so far, drink some water, and keep going. You're doing great." },
      { title: "Check in with your energy", body: "On a scale of 1–10, how's your energy? Open WELL and log how you're feeling." },
    ],
    evening: [
      { title: "Evening energy audit", body: "How did your energy feel today? Log it in WELL and spot what helped or hurt." },
      { title: "Set up tomorrow's energy", body: "Plan tomorrow's meals tonight. A little prep = a lot more energy all day." },
      { title: "Wind down to recharge", body: "No screens 30 minutes before bed. Your energy tomorrow starts with tonight's sleep." },
      { title: "Log your day", body: "Sleep, movement, meals — check them off in WELL. Every log builds a clearer energy picture." },
      { title: "Rest is energy, too", body: "Tonight's breathwork will help you wind down so tomorrow you wake up ready to go." },
      { title: "Proud of today?", body: "Log your streak and WELL Check progress. You're building real, lasting energy." },
      { title: "One last thing", body: "Set your bedtime goal tonight. 7–9 hours is what your energy is running on tomorrow." },
    ],
  },
  weight: {
    morning: [
      { title: "Healthy choices start now", body: "Log breakfast, drink water before your coffee, and set your nutrition intention for today." },
      { title: "Morning habit check", body: "Start with protein at breakfast — it'll keep you full and focused all morning." },
      { title: "Your plan is ready", body: "Check your daily plan in WELL. Small, consistent choices today are what create lasting change." },
      { title: "Fuel your morning right", body: "Don't skip breakfast. Log what you eat and notice how it affects your energy and hunger all day." },
      { title: "Today's mindset: progress, not perfection", body: "One good choice leads to another. Start with breakfast and build from there." },
      { title: "Good morning!", body: "Drink a glass of water before anything else. Hydration first is one of the easiest habits that works." },
      { title: "Set yourself up to succeed", body: "If you prepped yesterday — amazing! If not, open WELL and plan your first meal now." },
    ],
    afternoon: [
      { title: "Lunchtime check-in", body: "How's your nutrition today? Log your meals in WELL and stay on track with your protein goals." },
      { title: "Afternoon hunger or habit?", body: "Before you snack, ask: am I hungry or am I bored? If hungry — eat something with protein + fiber." },
      { title: "Midday momentum", body: "Take a 10-minute walk after lunch. It helps blood sugar balance and reduces afternoon cravings." },
      { title: "Hydration = fullness", body: "Drink 500ml of water right now before reaching for a snack. Often it's all you need." },
      { title: "Log it — even the small stuff", body: "Awareness is everything. Open WELL Nutrition and log your lunch, even if it wasn't perfect." },
      { title: "Afternoon check-in", body: "Notice how you feel after your meals today. Your body is giving you data — pay attention." },
      { title: "You're doing great", body: "Keep logging, keep moving, keep showing up. Consistency wins every time." },
    ],
    evening: [
      { title: "End the day strong", body: "No eating 2 hours before bed. Log tonight's dinner and check your macro totals." },
      { title: "Evening meal check", body: "Fill half your plate with vegetables, add protein, and log it in WELL Nutrition." },
      { title: "Tomorrow's prep is tonight", body: "Wash and cut veggies, plan tomorrow's meals, and set yourself up to succeed." },
      { title: "Log your wins", body: "Even if today wasn't perfect, log what you ate and find ONE thing you did well." },
      { title: "Sleep is part of the plan", body: "Poor sleep raises cortisol and hunger hormones. Log your sleep tonight and aim for 8 hours." },
      { title: "Reflect on today", body: "What went well? What would you do differently? WELL Check is a great place to log it." },
      { title: "Meal prep reminder", body: "Prep just one meal or snack for tomorrow. Future you will be so grateful." },
    ],
  },
  strength: {
    morning: [
      { title: "Train like you mean it", body: "Today's workout is waiting. Log it in WELL Cup and earn your points." },
      { title: "Rise and lift", body: "Fuel up with 25–30g of protein at breakfast. Your muscles will thank you at the gym." },
      { title: "Strength starts with showing up", body: "Open WELL for today's strength plan. Even a short session counts — consistency is everything." },
      { title: "Morning warrior mode", body: "Set your workout intention now. What are you training today? Log it after and feel the win." },
      { title: "Progressive overload begins here", body: "Good morning! Add 2 reps or slightly more weight than last session. Small increases = big results." },
      { title: "Feed the gains first", body: "Protein at breakfast, a solid warmup, and you're set. Your strength plan is in WELL." },
      { title: "Build something today", body: "Every rep, every set, every session is building a stronger version of you. Let's go." },
    ],
    afternoon: [
      { title: "Post-workout protein reminder", body: "Had your session? Eat 25–30g of protein within 30 minutes to support recovery." },
      { title: "Movement check", body: "Have you trained today? If not, even 20 minutes counts. Don't let the day get away from you." },
      { title: "Afternoon workout window", body: "If mornings are tough, now's a great time for your strength session. Open WELL to get started." },
      { title: "Recovery matters", body: "Stretch for 10 minutes today — it's as important as the workout itself." },
      { title: "Log your session", body: "Did you lift today? Log it in WELL Cup and track your progress over time." },
      { title: "Consistency check", body: "Three sessions this week? You're building real strength. Keep going." },
      { title: "Midday muscle check-in", body: "Log your steps, log your workout, check your macros. WELL Check is your daily scorecard." },
    ],
    evening: [
      { title: "Recover to grow", body: "Log your workout, stretch for 10–15 minutes, and get 8 hours of sleep. Muscle grows during rest." },
      { title: "Tonight's strength goal: sleep", body: "Recovery is where gains happen. Wind down, log your session if you haven't, and rest well." },
      { title: "Fuel tomorrow", body: "What's your protein plan for tomorrow? A little planning tonight = stronger performance tomorrow." },
      { title: "Log before you sleep", body: "Log your workout and meals in WELL. Tracking is what turns effort into visible results." },
      { title: "Rest day tonight?", body: "Active recovery — a stretch or walk — is just as valuable as a hard session. Log it." },
      { title: "Strong week recap", body: "How many sessions this week? Log tonight and celebrate how consistently you showed up." },
      { title: "You built something today", body: "Every training day is a deposit into your future strength. Log it and sleep well." },
    ],
  },
  rut: {
    morning: [
      { title: "Today is a fresh start", body: "Do ONE thing differently today. Take a new route, try a new class, eat something you've never made." },
      { title: "Break the pattern", body: "What's the one thing you keep putting off? Today's the day. WELL has your daily plan ready." },
      { title: "Shake things up", body: "Good morning! Try a class you've never done before. Change is what got you here — more change is what gets you out." },
      { title: "Start before you're ready", body: "You don't have to feel motivated to take the first step. Just open WELL and begin." },
      { title: "Permission to be new at something", body: "Try something today you've never done in WELL — a new breathwork, a new video, a new class." },
      { title: "One door opens everything", body: "What's the one small action that could shift your whole week? Do it before noon." },
      { title: "Morning magic", body: "Give yourself 20 minutes before the day starts — move, breathe, or just be still. It changes everything." },
    ],
    afternoon: [
      { title: "Inspiration drop", body: "Check today's inspiration in WELL — sometimes the right words at the right time unlock something." },
      { title: "Afternoon nudge", body: "Feeling the same old? Try the 5-minute rule: just do 5 minutes of something new. You'll probably keep going." },
      { title: "You need a spark", body: "Post something in Community. Connection is often the fastest way out of a rut." },
      { title: "Change one thing", body: "Take a different route on your walk, try a new playlist in WELL Music. Novelty is medicine." },
      { title: "Movement shifts everything", body: "Even 10 minutes of movement right now can change your mood, your energy, and your outlook." },
      { title: "How are you really?", body: "Check in with yourself. What do you actually need right now? Open WELL and do that thing." },
      { title: "Try something unexpected", body: "Open WELL Classes and pick one you've never tried. Worst case, you tried something new." },
    ],
    evening: [
      { title: "Reflect on today's shift", body: "What one new thing did you do today? Even tiny breaks from routine matter more than you think." },
      { title: "Write it out", body: "Journal for 10 minutes tonight. What's draining you? What lights you up? Follow the second one." },
      { title: "Tomorrow can be different", body: "Plan one thing tomorrow that breaks your usual pattern. Log it in WELL so you remember." },
      { title: "You're not stuck — you're between", body: "Between where you were and where you're going. Log your day and trust the process." },
      { title: "Wind down with curiosity", body: "Watch something new, read something different, try the evening breathwork in WELL. Novelty restores." },
      { title: "Future letter", body: "Who do you want to be in 3 months? Write 5 sentences. The rut ends when the vision gets clear." },
      { title: "You showed up today", body: "That's enough. Log your WELL Check and know that consistency — even imperfect — is what breaks ruts." },
    ],
  },
  community: {
    morning: [
      { title: "Your tribe is waiting", body: "Good morning! Open Community, say hi, or cheer someone on. Connection is the best morning boost." },
      { title: "Show up for your tribe today", body: "Post a morning intention in Community. When you share, others show up for you too." },
      { title: "Connection is your superpower", body: "Start the day by engaging with your Community. One comment can change someone's day." },
      { title: "Morning tribe check-in", body: "Who in Community could use some encouragement today? Be the one who shows up first." },
      { title: "Your people are here", body: "Open WELL and connect — comment, cheer, or share a win. That's what we're here for." },
      { title: "Community morning", body: "Share what you're working on today in Community. Accountability works best out loud." },
      { title: "The tribe lifts you", body: "Good morning! Start by reading what's happening in Community. You'll feel less alone in seconds." },
    ],
    afternoon: [
      { title: "Midday connection", body: "Take 5 minutes to engage in Community. React, reply, or post. Your presence matters." },
      { title: "Check the leaderboard", body: "How are your WELL Cup points today? Check the leaderboard and cheer on whoever's at the top." },
      { title: "Your tribe is here", body: "Feeling the midday slump? Open Community and post how you're feeling. Watch what comes back." },
      { title: "Encourage someone right now", body: "Find a Community post that resonates and leave a genuine reply. It takes 30 seconds and changes everything." },
      { title: "Community activity", body: "Something's happening in Community. Check in, engage, and be part of what makes this place special." },
      { title: "You belong here", body: "Post an update on your wellness day. The tribe wants to know how you're doing." },
      { title: "Invite someone in", body: "Think of one person who needs this community. Share your referral code with them today." },
    ],
    evening: [
      { title: "End with connection", body: "Before you wind down, share one win from today in Community. It'll lift someone up — including you." },
      { title: "Tribe reflection", body: "Who helped you this week? Send them a message tonight. Gratitude builds stronger bonds." },
      { title: "Evening community moment", body: "Read today's inspiration and share your reaction in Community. Connection is healing." },
      { title: "Celebrate someone", body: "Before bed, find someone in Community to congratulate. Their win is a preview of yours." },
      { title: "Tomorrow's plan", body: "Post your wellness intention for tomorrow in Community tonight. Public commitment = real commitment." },
      { title: "Your story matters", body: "What happened today worth sharing? Post it — someone in the tribe needs exactly what you experienced." },
      { title: "Rest with gratitude", body: "Log your WELL Check, reach out to one tribe member, and sleep well knowing you're not doing this alone." },
    ],
  },
};

// Tone adjustments — prepend a tone-specific opener to the body when relevant
function applyTone(copy: NotifCopy, tone: NotifTone | null): NotifCopy {
  if (!tone || tone === "motivation") return copy;
  if (tone === "accountability") {
    return { title: copy.title, body: `📋 ${copy.body}` };
  }
  if (tone === "gentle") {
    // Soften the title slightly by prefixing a warm cue
    return { title: `${copy.title} 🌿`, body: copy.body };
  }
  if (tone === "education") {
    return { title: copy.title, body: `💡 ${copy.body}` };
  }
  return copy;
}

function getPersonalizedCopy(
  goalPlan: GoalPlan | null,
  tone: NotifTone | null,
  timeSlot: TimeSlot,
  dayOfYear: number
): NotifCopy {
  const plan = goalPlan && GOAL_NOTIFS[goalPlan] ? GOAL_NOTIFS[goalPlan] : GOAL_NOTIFS.energy;
  const options = plan[timeSlot];
  const copy = options[dayOfYear % options.length];
  return applyTone(copy, tone);
}

// Runs every hour — fires goal-specific 3pm motivation push to each member in their local timezone.
// 7am (inspiration) and 9pm (WELL Check) are handled by the broadcast scheduler and are the same for everyone.
export function scheduleTimezoneNotifications() {
  cron.schedule("0 * * * *", async () => {
    try {
      const { rows: members } = await pool.query<{
        email: string;
        timezone: string;
        notification_schedule: { send3pm?: boolean } | null;
        goal_plan: GoalPlan | null;
        notification_tone: NotifTone | null;
      }>(
        `SELECT email, timezone, notification_schedule, goal_plan, notification_tone
         FROM members
         WHERE notification_schedule->>'send3pm' = 'true'`
      );

      const now = new Date();
      const dayOfYear = Math.floor(
        (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000
      );

      for (const member of members) {
        const timezone = member.timezone || "America/New_York";
        const userTimeString = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(now);

        const [hour, minute] = userTimeString.split(":").map(Number);
        if (hour !== 15 || minute >= 1) continue;

        const { title, body } = getPersonalizedCopy(
          member.goal_plan,
          member.notification_tone,
          "afternoon",
          dayOfYear
        );

        console.log(`[GOAL NOTIF] 3pm → ${member.email} (goal: ${member.goal_plan ?? "none"}): "${title}"`);

        await sendNotificationToUser(member.email, {
          title,
          body,
          tag: "motivation-boost",
          url: "/notifications",
        }).catch((err) => console.error(`[GOAL NOTIF] Failed for ${member.email}:`, err));

        await createMemberNotification({
          memberEmail: member.email,
          type: "general",
          title,
          body,
          link: "/notifications",
        }).catch((err) => console.error(`[GOAL NOTIF] Failed to save in-app notif for ${member.email}:`, err));
      }
    } catch (err) {
      console.error("[GOAL NOTIF] 3pm cron error:", err);
    }
  });
}
