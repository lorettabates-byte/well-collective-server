// Approved copy (day3), generated from the email rebuild 2026-09-29.
// Do not hand-edit placeholders: only ${firstName} is substituted.
// HTML values are escaped; subject and text values are stripped of control characters.
import { escapeHtml, plainText, RenderedEmail } from "./shared";

export function renderDay3Email(v: { firstName: string }): RenderedEmail {
  return {
    subject: subject(plainText(v.firstName)),
    html: html(escapeHtml(v.firstName)),
    text: text(plainText(v.firstName)),
  };
}

function subject(firstName: string): string {
  return `${firstName}, here is where the good stuff happens`;
}

function text(firstName: string): string {
  return `Hey ${firstName}!

You have been with us a few days now, so let me show you around. This is where our community spends the most time, and why they keep coming back.

01 THE WELL CUP
Points for showing up: your WELL Check, a class, a song, cheering someone on. Build a streak and climb the leaderboard. Every month the top scorer wins a free month.

02 WELL CHECK
Your daily snapshot: points, steps, sleep and every activity you logged today. Find it in your Profile. If you only do one thing today, make it this.

03 COMMUNITY
Share a win, ask a question or cheer someone on. This is where the WELL Collective really comes alive, and it needs what you have to offer.

And whenever you want more: classes, music, recipes and calm tools.

Open the app: https://app.lorettabates.com

Big hugs,
Loretta
`;
}

function html(firstName: string): string {
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
<title>A look inside</title>
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

<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#020810;">The three places our community loves most, and why.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>

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
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:#84D8FD;padding-top:4px;">The WELL Collective</div>
    </td>
  </tr>
  </table>
</td>
</tr>

<!-- HERO -->
<tr>
<td class="px" style="padding:36px 40px 8px 40px;text-align:left;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;">A look inside</div>
  <h1 class="h1 serif" style="margin:14px 0 0 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:44px;line-height:1.06;font-weight:600;color:#ffffff;text-align:left;">Where the good stuff <em style="font-style:italic;color:#84D8FD;">happens</em></h1>
  <div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style=""><tr><td width="56" height="2" bgcolor="#FFC72C" style="width:56px;height:2px;line-height:2px;font-size:0;background-color:#FFC72C;">&nbsp;</td></tr></table>

</td>
</tr>

<!-- BODY -->
<tr>
<td class="px" style="padding:24px 40px 0 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">
<p style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:1.6;color:#ffffff;text-align:left;">Hey ${firstName}!</p>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">You have been with us a few days now, so let me show you around. This is where our community spends the most time, and why they keep coming back.</p>
<div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="stack m-center" width="48%" valign="middle" style="width:48%;vertical-align:middle;padding-right:14px;padding-left:0;"><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-trophy-480.png" width="200" height="200" alt="The WELL Cup trophy" style="display:block;margin:0 auto;width:200px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:0px;"></td><td class="stack stack-gap" width="52%" valign="middle" style="width:52%;vertical-align:middle;padding-left:14px;padding-right:0;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;padding:0 0 6px 0;">01</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;font-weight:600;color:#ffffff;text-align:left;padding:0 0 8px 0;">The WELL Cup</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;">Points for showing up: your WELL Check, a class, a song, cheering someone on. Build a streak and climb the leaderboard. Every month the top scorer wins a free month.</div></td></tr></table>
<div style="height:1px;line-height:1px;font-size:0;background-color:rgba(132,216,253,0.12);margin:30px 0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl"><tr><td dir="ltr" class="stack m-center" width="48%" valign="middle" style="width:48%;vertical-align:middle;padding-left:14px;padding-right:0;"><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-email-phone-wellcheck.png" width="230" height="482" alt="The WELL Check screen in the app: points, steps, activities, sleep and today's activity log" style="display:block;margin:0 auto;width:230px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:0px;"></td><td dir="ltr" class="stack stack-gap" width="52%" valign="middle" style="width:52%;vertical-align:middle;padding-right:14px;padding-left:0;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;padding:0 0 6px 0;">02</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;font-weight:600;color:#ffffff;text-align:left;padding:0 0 8px 0;">WELL Check</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;">Your daily snapshot: points, steps, sleep and every activity you logged today. Find it in your Profile. If you only do one thing today, make it this.</div></td></tr></table>
<div style="height:1px;line-height:1px;font-size:0;background-color:rgba(132,216,253,0.12);margin:30px 0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="stack m-center" width="48%" valign="middle" style="width:48%;vertical-align:middle;padding-right:14px;padding-left:0;"><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-email-screen-community.png" width="250" height="279" alt="The Community screen in the app" style="display:block;margin:0 auto;width:250px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:0px;"></td><td class="stack stack-gap" width="52%" valign="middle" style="width:52%;vertical-align:middle;padding-left:14px;padding-right:0;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;padding:0 0 6px 0;">03</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;font-weight:600;color:#ffffff;text-align:left;padding:0 0 8px 0;">Community</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;">Share a win, ask a question or cheer someone on. This is where the WELL Collective really comes alive, and it needs what you have to offer.</div></td></tr></table>
<div style="height:34px;line-height:34px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="margin:0px 0 0px 0;background-color:#0a1624 !important;border:1px solid rgba(132,216,253,0.16);border-radius:16px;border-collapse:separate;"><tr><td class="info-pad" style="padding:22px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;text-align:left;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:center;padding:0 0 16px 0;">And whenever you want more</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="25%" valign="top" style="width:25%;text-align:center;vertical-align:top;padding:0 4px;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-circle-play.png" width="44" height="44" alt="Classes" style="display:block;width:44px;height:44px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#c9d9e6;padding-top:8px;">Classes</div></td><td width="25%" valign="top" style="width:25%;text-align:center;vertical-align:top;padding:0 4px;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-music.png" width="44" height="44" alt="Music" style="display:block;width:44px;height:44px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#c9d9e6;padding-top:8px;">Music</div></td><td width="25%" valign="top" style="width:25%;text-align:center;vertical-align:top;padding:0 4px;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-apple.png" width="44" height="44" alt="Recipes" style="display:block;width:44px;height:44px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#c9d9e6;padding-top:8px;">Recipes</div></td><td width="25%" valign="top" style="width:25%;text-align:center;vertical-align:top;padding:0 4px;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-wind.png" width="44" height="44" alt="Calm tools" style="display:block;width:44px;height:44px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#c9d9e6;padding-top:8px;">Calm tools</div></td></tr></table></td></tr></table>
<div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;"><tr><td align="center" bgcolor="#0191CE" style="border-radius:10px;background-color:#0191CE;background-image:linear-gradient(135deg,#01519D 0%,#0191CE 100%);"><a href="https://app.lorettabates.com" target="_blank" style="display:inline-block;padding:15px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:10px;">Open the app</a></td></tr></table>
<p style="margin:10px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#8fa6b8;">Get the app: <a href="https://apps.apple.com/us/app/well-with-loretta/id6789703038" target="_blank" style="color:#84D8FD;text-decoration:none;">iPhone</a> &nbsp;|&nbsp; <a href="https://play.google.com/store/apps/details?id=com.wellcollective.app" target="_blank" style="color:#84D8FD;text-decoration:none;">Android</a> &nbsp;|&nbsp; <a href="https://app.lorettabates.com" target="_blank" style="color:#84D8FD;text-decoration:none;">Web</a></p>
<p class="serif" style="margin:26px 0 0 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;font-style:italic;font-weight:500;color:#ffffff;text-align:left;">Big hugs,<br>Loretta</p>
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
    <div style="padding-top:18px;font-size:13px;line-height:1.5;color:#6f8597;">You are receiving this because you joined the WELL with Loretta App. Questions? Just reply, it comes straight to me.</div>
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
