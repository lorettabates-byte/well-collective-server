export interface ContentBatchEntry {
  date: string; // yyyy-mm-dd
  weeklyTheme?: { title: string; body: string };
  dailyInspiration?: { title: string; body: string };
  wellActivity?: { title: string; description: string };
  recipe?: { name: string; description: string; ingredients: string[]; steps: string[]; image: string };
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}
