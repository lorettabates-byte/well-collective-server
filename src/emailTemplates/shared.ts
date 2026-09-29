export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Escape a user-provided value for safe insertion into HTML text or attributes. */
export function escapeHtml(value: string): string {
  return plainText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip control characters (incl. CR/LF, which could break a subject line). */
export function plainText(value: string): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/**
 * First name for greetings. Falls back to "friend" when the name is empty or
 * looks like an email address (the test route passes the address as the name).
 */
export function firstNameFrom(name: string | null | undefined): string {
  const first = plainText(name || "").split(/\s+/)[0] || "";
  if (!first || first.includes("@")) return "friend";
  return first;
}
