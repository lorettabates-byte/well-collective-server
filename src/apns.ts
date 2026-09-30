import http2 from "node:http2";
import crypto from "node:crypto";

const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.wellcollective.app";
// Railway stores multi-line values fine, but tolerate a pasted single line with literal "\n".
const PRIVATE_KEY = process.env.APNS_KEY?.replace(/\\n/g, "\n");

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;
type ApnsEnv = keyof typeof HOSTS;

export const apnsReady = Boolean(KEY_ID && TEAM_ID && PRIVATE_KEY);
console.log(apnsReady ? "[APNS] Direct Apple push enabled" : "[APNS] APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID not set — iOS push disabled");

// Raw APNs device tokens are 64 hex chars; FCM registration tokens are longer and contain ':'.
export function isApnsToken(token: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(token);
}

let cachedJwt: { token: string; issuedAt: number } | null = null;

// Apple rejects tokens older than an hour and throttles ones refreshed more than every 20 minutes.
function getJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 45 * 60) return cachedJwt.token;
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "ES256", kid: KEY_ID })}.${b64({ iss: TEAM_ID, iat: now })}`;
  const signature = crypto
    .sign("sha256", Buffer.from(unsigned), { key: PRIVATE_KEY!, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  cachedJwt = { token: `${unsigned}.${signature}`, issuedAt: now };
  return cachedJwt.token;
}

const sessions: Partial<Record<ApnsEnv, http2.ClientHttp2Session>> = {};

function getSession(env: ApnsEnv): http2.ClientHttp2Session {
  const existing = sessions[env];
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(HOSTS[env]);
  session.on("error", (err) => console.error(`[APNS] ${env} session error:`, err));
  session.on("close", () => { if (sessions[env] === session) delete sessions[env]; });
  session.setTimeout(60000, () => session.close());
  sessions[env] = session;
  return session;
}

function post(env: ApnsEnv, token: string, body: string): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const req = getSession(env).request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${getJwt()}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = 0;
    let data = "";
    req.setEncoding("utf8");
    req.setTimeout(10000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (headers) => { status = Number(headers[":status"]); });
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      let reason: string | undefined;
      try { reason = data ? JSON.parse(data).reason : undefined; } catch { reason = data; }
      resolve({ status, reason });
    });
    req.on("error", reject);
    req.end(body);
  });
}

export type ApnsResult = "sent" | "invalid" | "failed";

/**
 * App Store/TestFlight installs use production APNs; Xcode debug installs use
 * sandbox. A token from the wrong environment comes back as BadDeviceToken, so
 * retry once against sandbox before treating the token as dead.
 */
export async function sendApns(
  token: string,
  payload: { title: string; body: string; url?: string; tag?: string }
): Promise<ApnsResult> {
  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, badge: 1, sound: "default" },
    url: payload.url || "/",
    tag: payload.tag || "",
  });
  try {
    let res = await post("production", token, body);
    if (res.status === 400 && res.reason === "BadDeviceToken") {
      const sandbox = await post("sandbox", token, body);
      // A production-only key can't reach sandbox; keep the production verdict.
      if (sandbox.reason !== "BadEnvironmentKeyInToken") res = sandbox;
    }
    if (res.status === 200) return "sent";
    if (res.status === 410 || (res.status === 400 && res.reason === "BadDeviceToken")) return "invalid";
    console.error(`[APNS] Send failed: ${res.status} ${res.reason ?? ""}`);
    return "failed";
  } catch (err) {
    console.error("[APNS] Send error:", err);
    return "failed";
  }
}
