const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function isAnthropicConfigured(): boolean {
  return !!ANTHROPIC_API_KEY;
}

async function callClaude(prompt: string, maxTokens = 600): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content.find((block) => block.type === "text");
  if (!textBlock?.text) {
    throw new Error("Anthropic response had no text content");
  }
  return textBlock.text;
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in AI response");
  }
  return JSON.parse(match[0]);
}

export interface GeneratedMotivationBoost {
  title: string;
  body: string;
}

export async function generateMotivationBoost(
  weeklyThemeTitle: string | undefined,
  dailyInspirationTitle: string | undefined
): Promise<GeneratedMotivationBoost> {
  const themeContext = weeklyThemeTitle
    ? `This week's theme for the WELL Collective wellness community is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme set right now.";
  const dailyContext = dailyInspirationTitle
    ? ` Today's daily inspiration is titled "${dailyInspirationTitle}".`
    : "";

  const prompt = `You are writing a short, warm "Motivation Boost" message for the WELL Collective, a women's wellness community app run by Loretta Bates. ${themeContext}${dailyContext}

Write one brand-new motivation boost that complements (does not repeat) the above. It should feel like an encouraging friend, not a generic quote account. Avoid cliches like "you got this."

Respond with ONLY a JSON object, no other text, in this exact shape:
{"title": "a short punchy title, under 8 words", "body": "2-3 warm, specific sentences"}`;

  const text = await callClaude(prompt, 400);
  const parsed = extractJson(text) as GeneratedMotivationBoost;
  if (!parsed.title || !parsed.body) {
    throw new Error("AI motivation boost response missing title/body");
  }
  return parsed;
}

export interface GeneratedRecipe {
  name: string;
  description: string;
  ingredients: string[];
  steps: string[];
}

export async function generateRecipe(weeklyThemeTitle: string | undefined): Promise<GeneratedRecipe> {
  const themeContext = weeklyThemeTitle
    ? `This week's wellness theme is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme right now, so keep it generally nourishing and approachable.";

  const prompt = `You are writing a simple, healthy recipe for the WELL Collective, a women's wellness community app. ${themeContext}

Write one recipe that ties into that theme (e.g. comforting, energizing, calming, restorative — whatever fits). Keep it realistic for a home cook: 5-8 ingredients, 4-6 short steps.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"name": "recipe name", "description": "1 short sentence on why it fits this week", "ingredients": ["...", "..."], "steps": ["...", "..."]}`;

  const text = await callClaude(prompt, 700);
  const parsed = extractJson(text) as GeneratedRecipe;
  if (!parsed.name || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error("AI recipe response missing required fields");
  }
  return parsed;
}

export async function generateNutritionTip(): Promise<string> {
  const prompt = `Write one short, practical nutrition tip of the day (1-2 sentences, under 200 characters) for the WELL Collective women's wellness community. Make it specific and actionable, not generic.

Respond with ONLY the tip text, no quotes, no JSON, no extra commentary.`;

  const text = await callClaude(prompt, 150);
  return text.trim();
}
