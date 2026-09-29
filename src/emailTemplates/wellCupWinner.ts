// Approved copy (wellcup-winner), generated from the email rebuild 2026-09-29.
// Do not hand-edit placeholders: only ${firstName}, ${monthName}, ${pointsText} are substituted.
// HTML values are escaped; subject and text values are stripped of control characters.
import { escapeHtml, plainText, RenderedEmail } from "./shared";

export function renderWellCupWinnerEmail(v: { firstName: string; monthName: string; points: number }): RenderedEmail {
  const pts = v.points.toLocaleString("en-US");
  return {
    subject: subject(plainText(v.firstName), plainText(v.monthName), pts),
    html: html(escapeHtml(v.firstName), escapeHtml(v.monthName), escapeHtml(pts)),
    text: text(plainText(v.firstName), plainText(v.monthName), pts),
  };
}

function subject(firstName: string, monthName: string, pointsText: string): string {
  return `${firstName}, you won the ${monthName} WELL Cup!`;
}

function text(firstName: string, monthName: string, pointsText: string): string {
  return `${firstName}, you won the ${monthName} WELL Cup!

I am so proud of you! You finished at the top of the WELL Cup leaderboard with ${pointsText} points. That is a whole month of showing up for yourself, and it lifted all of us.

YOUR PRIZE: A FREE MONTH OF THE WELL COLLECTIVE
Your next month of membership is on me. You do not need to do a thing. I will take care of it and let you know when it is all set.

YOUR SHARE CARDS ARE READY
1. Open the app. Your winner banner is waiting on the home screen.
2. Tap Share on the banner.
3. Download your card for an Instagram Story or for Facebook, and post it!

Get my share cards: https://app.lorettabates.com/

One little note: so everyone gets a turn, monthly winners sit out the daily and monthly prizes for a month. Keep earning points, and you will be right back in the running after that.

Big hugs,
Loretta
`;
}

function html(firstName: string, monthName: string, pointsText: string): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" style="color-scheme:dark;background-color:#020810;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>You won the WELL Cup</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500;1,600&amp;display=swap" rel="stylesheet">
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>.serif{font-family:Georgia,serif !important}</style>
<![endif]-->
<style>
:root{color-scheme:dark;supported-color-schemes:dark}
html,body{margin:0 !important;padding:0 !important;width:100% !important;background:#020810 !important;background-color:#020810 !important}
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a{color:#84D8FD}
.bg-outer{background:#020810 !important;background-color:#020810 !important}
.bg-card{background:#050b14 !important;background-color:#050b14 !important}
.bg-info{background:#0a1624 !important;background-color:#0a1624 !important}
[data-ogsc] .bg-outer,[data-ogsb] .bg-outer{background-color:#020810 !important}
[data-ogsc] .bg-card,[data-ogsb] .bg-card{background-color:#050b14 !important}
[data-ogsc] .bg-info,[data-ogsb] .bg-info{background-color:#0a1624 !important}
@media (prefers-color-scheme: dark){
  .bg-outer{background-color:#020810 !important}
  .bg-card{background-color:#050b14 !important}
  .bg-info{background-color:#0a1624 !important}
}
@media (prefers-color-scheme: light){
  body,.bg-outer{background-color:#020810 !important}
  .bg-card{background-color:#050b14 !important}
  .bg-info{background-color:#0a1624 !important}
}
@media screen and (max-width:640px){
  .container{width:100% !important;max-width:100% !important}
  .outer-pad{padding:16px 10px !important}
  .px{padding-left:22px !important;padding-right:22px !important}
  .h1{font-size:36px !important;line-height:1.08 !important}
  .h2{font-size:26px !important}
  .info-pad{padding:18px 18px !important}
  .stack{display:block !important;width:100% !important;padding-left:0 !important;padding-right:0 !important}
  .stack-gap{padding-top:18px !important}
  .m-center{text-align:center !important}
  .m-center img{margin:0 auto !important}
  .big-num{font-size:96px !important}
}
</style>
</head>
<body class="bg-outer" bgcolor="#020810" style="margin:0;padding:0;background:#020810 !important;background-color:#020810 !important;">

<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#020810;">Your free month of the WELL Collective is on me. Your share cards are ready.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-outer" bgcolor="#020810" style="background:#020810 !important;background-color:#020810 !important;">
<tr>
<td align="center" class="outer-pad" style="padding:32px 16px;">

<!--[if mso]><table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="container bg-card" width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#050b14" style="width:620px;max-width:620px;background:#050b14 !important;background-color:#050b14 !important;border:1px solid rgba(132,216,253,0.14);border-radius:18px;border-collapse:separate;">

<!-- HEADER: transparent logo, no tile behind it -->
<tr>
<td class="px" style="padding:30px 40px 24px 40px;border-bottom:1px solid rgba(132,216,253,0.10);">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="middle" style="width:84px;text-align:center;vertical-align:middle;">
      <img src="https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png" alt="WELL" width="84" style="display:inline-block;width:84px;margin:-14px 0 -14px -14px;height:auto;border:0;vertical-align:middle;">
    </td>
    <td valign="middle" style="padding-left:16px;vertical-align:middle;">
      <div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:26px;line-height:1.1;font-weight:500;color:#f3f8fc;">WELL with Loretta</div>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:#84D8FD;padding-top:4px;">The WELL Cup</div>
    </td>
  </tr>
  </table>
</td>
</tr>

<!-- TOP VISUAL -->
<tr>
<td class="px" style="padding:28px 40px 0 40px;">
<img src="https://lorettabates.com/wp-content/uploads/2026/09/well-email-wellcup-confetti.gif" width="540" height="324" alt="Confetti falling around the WELL Cup trophy" style="display:block;width:540px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:16px;">
</td>
</tr>

<!-- HERO -->
<tr>
<td class="px" style="padding:30px 40px 8px 40px;text-align:center;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:center;">${monthName} WELL Cup winner</div>
  <h1 class="h1 serif" style="margin:14px 0 0 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:44px;line-height:1.06;font-weight:600;color:#ffffff;text-align:center;">You <em style="font-style:italic;color:#84D8FD;">won</em>, ${firstName}!</h1>
  <div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td width="56" height="2" bgcolor="#FFC72C" style="width:56px;height:2px;line-height:2px;font-size:0;background-color:#FFC72C;">&nbsp;</td></tr></table>

</td>
</tr>

<!-- BODY -->
<tr>
<td class="px" style="padding:24px 40px 0 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:center;">
<p style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:1.7;color:#c9d9e6;text-align:center;">I am so proud of you! You finished at the top of the WELL Cup leaderboard. That is a whole month of showing up for yourself, and it lifted all of us.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0 0;"><tr><td class="stack stack-gap" width="50%" valign="top" style="width:50%;vertical-align:top;padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="background-color:#0a1624 !important;border:1px solid rgba(132,216,253,0.20);border-radius:14px;border-collapse:separate;"><tr><td style="padding:20px 14px;text-align:center;"><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:34px;line-height:1.1;font-weight:600;color:#ffffff;">${monthName}</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;padding-top:6px;">Your month</div></td></tr></table></td><td class="stack stack-gap" width="50%" valign="top" style="width:50%;vertical-align:top;padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="background-color:#0a1624 !important;border:1px solid rgba(132,216,253,0.20);border-radius:14px;border-collapse:separate;"><tr><td style="padding:20px 14px;text-align:center;"><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:34px;line-height:1.1;font-weight:600;color:#ffffff;">${pointsText}</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;padding-top:6px;">Your points</div></td></tr></table></td></tr></table>
<div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="margin:0px 0 0px 0;background-color:#0a1624 !important;border:1px solid rgba(255,199,44,0.45);border-radius:16px;border-collapse:separate;"><tr><td class="info-pad" style="padding:26px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;text-align:center;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-gift.png" width="56" height="56" alt="Your prize" style="display:block;width:56px;height:56px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:center;padding:12px 0 4px 0;">Your prize</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;font-weight:600;color:#ffffff;text-align:center;padding:0 0 8px 0;">A free month of the WELL Collective</div><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#c9d9e6;text-align:center;">Your next month of membership is on me. You do not need to do a thing. I will take care of it and let you know when it is all set.</p>
</td></tr></table>
<div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:center;padding:0 0 6px 0;">Now tell the world</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:32px;line-height:1.15;font-weight:600;color:#ffffff;text-align:center;padding:0 0 14px 0;">Your share cards are <em style="color:#84D8FD;">ready</em></div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="margin:0px 0 0px 0;background-color:#0a1624 !important;border:1px solid rgba(132,216,253,0.16);border-radius:16px;border-collapse:separate;"><tr><td class="info-pad" style="padding:20px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;text-align:left;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#c9d9e6;text-align:left;"><strong style="color:#ffffff;">1.</strong> Open the app. Your winner banner is waiting on the home screen.<br><strong style="color:#ffffff;">2.</strong> Tap <strong style="color:#ffffff;">Share</strong> on the banner.<br><strong style="color:#ffffff;">3.</strong> Download your card for an Instagram Story or for Facebook, and post it!</div></td></tr></table>
<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto;"><tr><td align="center" bgcolor="#0191CE" style="border-radius:10px;background-color:#0191CE;background-image:linear-gradient(135deg,#01519D 0%,#0191CE 100%);"><a href="https://app.lorettabates.com/" target="_blank" style="display:inline-block;padding:15px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:10px;">Get my share cards</a></td></tr></table>
<p style="margin:6px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#8fa6b8;text-align:center;">On your phone? <a href="wellcollective://home" style="color:#84D8FD;text-decoration:none;">Open the WELL with Loretta App</a></p>
<div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#8fa6b8;text-align:center;">One little note: so everyone gets a turn, monthly winners sit out the daily and monthly prizes for a month. Keep earning points, and you will be right back in the running after that.</p>
<p class="serif" style="margin:26px 0 0 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;font-style:italic;font-weight:500;color:#ffffff;text-align:center;">Big hugs,<br>Loretta</p>
</td>
</tr>

<!-- FOOTER -->
<tr>
<td class="px" style="padding:36px 40px 34px 40px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(132,216,253,0.14);">
  <tr><td style="padding-top:26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#8fa6b8;">
    <div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#ffffff;">Loretta Bates</div>
    <div style="padding-top:2px;">Zumba&reg; Education Specialist, wellness educator and retreat host</div>
    <div style="padding-top:6px;"><a href="https://lorettabates.com" target="_blank" style="color:#84D8FD;text-decoration:none;">lorettabates.com</a> &nbsp;|&nbsp; <span style="color:#c9d9e6;">Live life lifted</span></div>
    <div style="padding-top:16px;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;">
      <a href="https://facebook.com/TheLorettaBates" target="_blank" style="color:#c9d9e6;text-decoration:none;white-space:nowrap;">Facebook</a> &nbsp;&nbsp;
      <a href="https://instagram.com/lorettabates" target="_blank" style="color:#c9d9e6;text-decoration:none;white-space:nowrap;">Instagram</a> &nbsp;&nbsp;
      <a href="https://youtube.com/user/lorettabates" target="_blank" style="color:#c9d9e6;text-decoration:none;white-space:nowrap;">YouTube</a> &nbsp;&nbsp;
      <a href="https://www.tiktok.com/@lorettabates" target="_blank" style="color:#c9d9e6;text-decoration:none;white-space:nowrap;">TikTok</a>
    </div>
    <div style="padding-top:18px;font-size:13px;line-height:1.5;color:#6f8597;">You are receiving this because you won the monthly WELL Cup in the WELL with Loretta App. Questions? Just reply, it comes straight to me.</div>
  </td></tr>
  </table>
</td>
</tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->

</td>
</tr>
</table>
</body>
</html>
`;
}
