/**
 * Renders every member lifecycle email template with sample data and asserts
 * brand and safety rules. Sends nothing. Run: npm run test:emails
 */
import assert from "node:assert/strict";
import {
  RenderedEmail,
  firstNameFrom,
  renderDay15Email,
  renderDay3Email,
  renderTrialEndedEmail,
  renderTrialEndingEmail,
  renderWelcomeEmail,
  renderWellCupWinnerEmail,
} from "../src/emailTemplates";

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/u;

function render(firstName: string): Record<string, RenderedEmail> {
  return {
    welcome: renderWelcomeEmail({ firstName }),
    day3: renderDay3Email({ firstName }),
    day15: renderDay15Email({ firstName }),
    "trial-ending": renderTrialEndingEmail({ firstName }),
    "trial-ended": renderTrialEndedEmail({ firstName }),
    "wellcup-winner": renderWellCupWinnerEmail({ firstName, monthName: "September 2026", points: 12345 }),
  };
}

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${label}: ${(err as Error).message}`);
  }
}

for (const [id, e] of Object.entries(render("Kendall"))) {
  for (const part of ["subject", "html", "text"] as const) {
    const s = e[part];
    check(`${id}.${part} has content`, () => assert.ok(s.length > 0));
    check(`${id}.${part} has no em dash`, () => assert.ok(!s.includes("—")));
    check(`${id}.${part} has no en dash`, () => assert.ok(!s.includes("–")));
    check(`${id}.${part} has no emoji`, () => assert.ok(!EMOJI.test(s), String(s.match(EMOJI))));
    check(`${id}.${part} has no leftover \${`, () => assert.ok(!s.includes("${")));
    check(`${id}.${part} has no backtick`, () => assert.ok(!s.includes("`")));
  }
  check(`${id} subject is one line`, () => assert.ok(!/[\r\n]/.test(e.subject)));
  check(`${id} greets by name`, () => {
    assert.ok(e.subject.includes("Kendall") || e.text.includes("Kendall"));
    assert.ok(e.html.includes("Kendall"));
  });
  check(`${id} html is a full document`, () => assert.match(e.html, /^<!DOCTYPE html>/));
}

const w = render("Kendall")["wellcup-winner"];
check("wellcup-winner shows month and points", () => {
  assert.ok(w.subject.includes("September 2026"));
  assert.ok(w.html.includes("September 2026") && w.html.includes("12,345"));
  assert.ok(w.text.includes("12,345"));
});

// HTML escaping of user-provided names
for (const [id, e] of Object.entries(render('<script>x</script>&"'))) {
  check(`${id} escapes name in html`, () => {
    assert.ok(!e.html.includes("<script>x</script>"));
    assert.ok(e.html.includes("&lt;script&gt;x&lt;/script&gt;&amp;&quot;"));
  });
}
check("newline in name cannot break the subject", () => {
  assert.ok(!/[\r\n]/.test(renderWelcomeEmail({ firstName: "A\r\nBcc: x@y.z" }).subject));
});

check("firstNameFrom fallbacks", () => {
  assert.equal(firstNameFrom("Kendall Bates"), "Kendall");
  assert.equal(firstNameFrom(""), "friend");
  assert.equal(firstNameFrom(null), "friend");
  assert.equal(firstNameFrom("someone@example.com"), "friend");
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll email template checks passed");
