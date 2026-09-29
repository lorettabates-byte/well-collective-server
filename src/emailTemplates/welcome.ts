// Approved copy (welcome), generated from the email rebuild 2026-09-29.
// Do not hand-edit placeholders: only ${firstName} is substituted.
// HTML values are escaped; subject and text values are stripped of control characters.
import { escapeHtml, plainText, RenderedEmail } from "./shared";

export function renderWelcomeEmail(v: { firstName: string }): RenderedEmail {
  return {
    subject: subject(plainText(v.firstName)),
    html: html(escapeHtml(v.firstName)),
    text: text(plainText(v.firstName)),
  };
}

function subject(firstName: string): string {
  return `Welcome in, ${firstName}. Your 30 days start now`;
}

function text(firstName: string): string {
  return `Hi ${firstName}!

I am so happy you are here. For the next 30 days, everything inside the WELL with Loretta App is yours to explore. You do not have to do it all at once.

YOUR NEW HOME
Your WELL Check, the WELL Cup, Community, classes, music and recipes. Sign in with this same email.
iPhone: https://apps.apple.com/us/app/well-with-loretta/id6789703038
Android: https://play.google.com/store/apps/details?id=com.wellcollective.app
Web: https://app.lorettabates.com

START WITH THESE THREE
1. Do your WELL Check. Less than a minute to notice how you are really doing.
2. Earn WELL Cup points. Almost everything earns points. The monthly winner gets a free month.
3. Say hi in Community. Tell us your name and one thing you want more of.

I am so proud of you for saying yes to yourself. Let's live life lifted... together!

With love,
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
<title>Welcome to WELL with Loretta</title>
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

<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#020810;">Three simple things to do first. I am so glad you are here.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>

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

<!-- TOP VISUAL -->
<tr>
<td class="px" style="padding:28px 40px 0 40px;">
<img src="https://lorettabates.com/wp-content/uploads/2026/09/well-email-loretta-denim.jpg" width="540" height="338" alt="Loretta Bates smiling in a denim jacket" style="display:block;width:540px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:16px;">
</td>
</tr>

<!-- HERO -->
<tr>
<td class="px" style="padding:30px 40px 8px 40px;text-align:left;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;">Your 30-day trial starts today</div>
  <h1 class="h1 serif" style="margin:14px 0 0 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:44px;line-height:1.06;font-weight:600;color:#ffffff;text-align:left;">Welcome in, <em style="font-style:italic;color:#84D8FD;">${firstName}</em></h1>
  <div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style=""><tr><td width="56" height="2" bgcolor="#FFC72C" style="width:56px;height:2px;line-height:2px;font-size:0;background-color:#FFC72C;">&nbsp;</td></tr></table>

</td>
</tr>

<!-- BODY -->
<tr>
<td class="px" style="padding:24px 40px 0 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">
<p style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:1.6;color:#ffffff;text-align:left;">Hi ${firstName}!</p>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">I am so happy you are here. For the next 30 days, everything inside the WELL with Loretta App is yours to explore. You do not have to do it all at once.</p>
<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="margin:0px 0 0px 0;background-color:#0a1624 !important;border:1px solid rgba(132,216,253,0.16);border-radius:16px;border-collapse:separate;"><tr><td class="info-pad" style="padding:26px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;text-align:left;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="stack m-center" width="46%" valign="middle" style="width:46%;vertical-align:middle;padding-right:14px;padding-left:0;"><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-email-phone-home.png" width="220" height="368" alt="The WELL with Loretta App home screen" style="display:block;margin:0 auto;width:220px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:0px;"></td><td class="stack stack-gap" width="54%" valign="middle" style="width:54%;vertical-align:middle;padding-left:14px;padding-right:0;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;padding:0 0 8px 0;">Your new home</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;font-weight:600;color:#ffffff;text-align:left;padding:0 0 10px 0;">Everything in <em style="color:#84D8FD;">one place</em></div><p style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">Your WELL Check, the WELL Cup, Community, classes, music and recipes. Sign in with this same email.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 0;"><tr><td align="center" bgcolor="#0191CE" style="border-radius:10px;background-color:#0191CE;background-image:linear-gradient(135deg,#01519D 0%,#0191CE 100%);"><a href="https://apps.apple.com/us/app/well-with-loretta/id6789703038" target="_blank" style="display:inline-block;padding:13px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:10px;">Get it for iPhone</a></td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 0;"><tr><td align="center" bgcolor="#0191CE" style="border-radius:10px;background-color:#0191CE;background-image:linear-gradient(135deg,#01519D 0%,#0191CE 100%);"><a href="https://play.google.com/store/apps/details?id=com.wellcollective.app" target="_blank" style="display:inline-block;padding:13px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:10px;">Get it for Android</a></td></tr></table><p style="margin:4px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#8fa6b8;">Or open it on the web at <a href="https://app.lorettabates.com" target="_blank" style="color:#84D8FD;text-decoration:none;">app.lorettabates.com</a></p></td></tr></table>
</td></tr></table>
<div style="height:34px;line-height:34px;font-size:0;">&nbsp;</div>
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:center;padding:0 0 18px 0;">Start with these three</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="stack stack-gap" width="33%" valign="top" style="width:33%;vertical-align:top;padding:0 8px;text-align:center;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-heart-pulse.png" width="56" height="56" alt="WELL Check" style="display:block;width:56px;height:56px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:700;color:#84D8FD;padding:12px 0 2px 0;">01</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;font-weight:600;color:#ffffff;padding-bottom:6px;">Do your WELL Check</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#c9d9e6;">Less than a minute to notice how you are really doing.</div></td><td class="stack stack-gap" width="33%" valign="top" style="width:33%;vertical-align:top;padding:0 8px;text-align:center;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-trophy.png" width="56" height="56" alt="WELL Cup" style="display:block;width:56px;height:56px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:700;color:#84D8FD;padding:12px 0 2px 0;">02</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;font-weight:600;color:#ffffff;padding-bottom:6px;">Earn WELL Cup points</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#c9d9e6;">Almost everything earns points. The monthly winner gets a free month.</div></td><td class="stack stack-gap" width="33%" valign="top" style="width:33%;vertical-align:top;padding:0 8px;text-align:center;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-users.png" width="56" height="56" alt="Community" style="display:block;width:56px;height:56px;max-width:100%;border:0;outline:none;text-decoration:none;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:700;color:#84D8FD;padding:12px 0 2px 0;">03</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;font-weight:600;color:#ffffff;padding-bottom:6px;">Say hi in Community</div><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#c9d9e6;">Tell us your name and one thing you want more of.</div></td></tr></table>
<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">I am so proud of you for saying yes to yourself. Let's live life lifted... together!</p>
<p class="serif" style="margin:26px 0 0 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;font-style:italic;font-weight:500;color:#ffffff;text-align:left;">With love,<br>Loretta</p>
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
    <div style="padding-top:18px;font-size:13px;line-height:1.5;color:#6f8597;">You are receiving this because you started a free 30-day trial of the WELL with Loretta App. Questions? Just reply, it comes straight to me.</div>
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
