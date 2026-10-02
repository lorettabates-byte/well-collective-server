// Approved copy (day15), generated from the email rebuild 2026-09-29.
// Do not hand-edit placeholders: only ${firstName} is substituted.
// HTML values are escaped; subject and text values are stripped of control characters.
import { escapeHtml, plainText, RenderedEmail } from "./shared";

export function renderDay15Email(v: { firstName: string }): RenderedEmail {
  return {
    subject: subject(plainText(v.firstName)),
    html: html(escapeHtml(v.firstName)),
    text: text(plainText(v.firstName)),
  };
}

function subject(firstName: string): string {
  return `${firstName}, 15 days in. How do you feel?`;
}

function text(firstName: string): string {
  return `Halfway there, ${firstName}!

15 OF 30 DAYS

Can you believe it? You are halfway through your 30-day trial. Let's make the next 15 days your best yet.

THE STREAK CHALLENGE: SHOW UP 7 DAYS IN A ROW
One small thing a day: your WELL Check, a short class, a song, a post. Every day earns WELL Cup points and grows your streak.

A little note from me: it is not about doing everything. It is about doing something, most days. I see you showing up, and I am so proud of you.

See my WELL Cup standing: https://app.lorettabates.com/well-cup

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
<title>Halfway there</title>
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

<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#020810;">15 days in. Here is a little challenge for the next 15.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>

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

<!-- BODY -->
<tr>
<td class="px" style="padding:24px 40px 0 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">
<div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;padding:0 0 12px 0;">Halfway there, ${firstName}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="bottom" style="vertical-align:bottom;"><span class="serif big-num" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:128px;line-height:1;font-weight:600;color:#ffffff;font-variant-numeric:lining-nums;">15</span><span class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:34px;line-height:1;font-weight:500;font-style:italic;color:#84D8FD;"> of 30 days</span></td></tr></table><div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="50%" height="10" bgcolor="#0191CE" style="width:50%;height:10px;line-height:10px;font-size:0;background-color:#0191CE;background-image:linear-gradient(90deg,#01519D 0%,#0191CE 70%,#84D8FD 100%);border-radius:10px 0 0 10px;">&nbsp;</td><td width="3" height="10" bgcolor="#FFC72C" style="width:3px;height:10px;line-height:10px;font-size:0;background-color:#FFC72C;">&nbsp;</td><td height="10" bgcolor="#142339" style="height:10px;line-height:10px;font-size:0;background-color:#142339;border-radius:0 10px 10px 0;">&nbsp;</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;"><tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#8fa6b8;text-align:left;">Day 1</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#ffffff;font-weight:700;text-align:center;">You are here</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#8fa6b8;text-align:right;">Day 30</td></tr></table><div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:left;">Can you believe it? You are halfway through your 30-day trial. Let's make the next 15 days your best yet.</p>
<div style="height:26px;line-height:26px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-info" bgcolor="#0a1624" style="margin:0px 0 0px 0;background-color:#0a1624 !important;border:1px solid rgba(132,216,253,0.16);border-radius:16px;border-collapse:separate;"><tr><td class="info-pad" style="padding:28px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#c9d9e6;text-align:center;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-icon-trophy-480.png" width="72" height="72" alt="WELL Cup" style="display:block;margin:0 auto;width:72px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:0px;"></td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:center;padding:14px 0 6px 0;">The streak challenge</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:30px;line-height:1.15;font-weight:600;color:#ffffff;text-align:center;padding:0 0 10px 0;">Show up <em style="color:#84D8FD;">7 days</em> in a row</div><p style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#c9d9e6;text-align:center;">One small thing a day: your WELL Check, a short class, a song, a post. Every day earns WELL Cup points and grows your streak.</p>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#0191CE" style="width:38px;height:38px;border-radius:19px;background-color:#0191CE;background-image:linear-gradient(135deg,#01519D 0%,#0191CE 100%);color:#ffffff;border:1px solid #84D8FD;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">15</td></tr></table><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#84D8FD;padding-top:6px;">Today</div></td><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#050b14" style="width:38px;height:38px;border-radius:19px;background-color:#050b14;color:#8fa6b8;border:1px solid rgba(132,216,253,0.30);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">16</td></tr></table></td><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#050b14" style="width:38px;height:38px;border-radius:19px;background-color:#050b14;color:#8fa6b8;border:1px solid rgba(132,216,253,0.30);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">17</td></tr></table></td><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#050b14" style="width:38px;height:38px;border-radius:19px;background-color:#050b14;color:#8fa6b8;border:1px solid rgba(132,216,253,0.30);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">18</td></tr></table></td><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#050b14" style="width:38px;height:38px;border-radius:19px;background-color:#050b14;color:#8fa6b8;border:1px solid rgba(132,216,253,0.30);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">19</td></tr></table></td><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#050b14" style="width:38px;height:38px;border-radius:19px;background-color:#050b14;color:#8fa6b8;border:1px solid rgba(132,216,253,0.30);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">20</td></tr></table></td><td align="center" valign="top" style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#050b14" style="width:38px;height:38px;border-radius:19px;background-color:#050b14;color:#8fa6b8;border:1px solid rgba(132,216,253,0.30);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">21</td></tr></table></td></tr></table></td></tr></table>
<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="stack m-center" width="22%" valign="middle" style="width:22%;vertical-align:middle;padding-right:10px;padding-left:0;"><img src="https://lorettabates.com/wp-content/uploads/2026/09/well-email-loretta-smile-circle.png" width="96" height="96" alt="Loretta Bates" style="display:block;margin:0 auto;width:96px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;border-radius:48px;"></td><td class="stack stack-gap m-center" width="78%" valign="middle" style="width:78%;vertical-align:middle;padding-left:10px;padding-right:0;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:#84D8FD;text-align:left;padding:0 0 6px 0;">A little note from me</div><div class="serif" style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:21px;line-height:1.45;font-style:italic;font-weight:500;color:#ffffff;">It is not about doing everything. It is about doing something, most days. I see you showing up, and I am so proud of you.</div></td></tr></table>
<div style="height:26px;line-height:26px;font-size:0;">&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;"><tr><td align="center" bgcolor="#0191CE" style="border-radius:10px;background-color:#0191CE;background-image:linear-gradient(135deg,#01519D 0%,#0191CE 100%);"><a href="https://app.lorettabates.com/well-cup" target="_blank" style="display:inline-block;padding:15px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:10px;">See my WELL Cup standing</a></td></tr></table>
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
    <div style="padding-top:18px;font-size:13px;line-height:1.5;color:#6f8597;">You are receiving this because you are on a free 30-day trial of the WELL with Loretta App. Questions? Just reply, it comes straight to me.</div>
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
