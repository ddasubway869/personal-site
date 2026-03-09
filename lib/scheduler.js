'use strict';
const cron      = require('node-cron');
const mailer    = require('./mailer');
const { getDb } = require('../db');

// Returns the ISO week key, e.g. "2026-W10"
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo    = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Returns just the week number, e.g. 10
function weekNumber(key) {
  return parseInt(key.split('-W')[1], 10);
}

const BASE_URL = process.env.BASE_URL || 'https://arvl.app';

// ── HTML email builder ────────────────────────────────────

function buildEmail({ eyebrow, heading, body, ctaLabel, theme = 'dark' }) {
  const t = theme === 'light'
    ? { bg: '#f5f5f5', card: '#ffffff', border: '#e0e0e0', title: '#111111', muted: '#888888', body: '#555555', btn: '#111111', btnText: '#ffffff', footer: '#aaaaaa' }
    : { bg: '#0f0f0f', card: '#1a1a1a', border: '#2a2a2a', title: '#ffffff', muted: '#666666', body: '#999999', btn: '#ffffff', btnText: '#0f0f0f', footer: '#333333' };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:${t.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg};padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <tr>
            <td style="padding-bottom:32px;text-align:center;">
              <span style="font-size:22px;font-weight:700;letter-spacing:-.5px;color:${t.title};">ARVL</span>
            </td>
          </tr>

          <tr>
            <td style="background:${t.card};border:1px solid ${t.border};border-radius:12px;padding:40px 36px;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${t.muted};">${eyebrow}</p>
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${t.title};line-height:1.3;">${heading}</h1>
              <p style="margin:0 0 32px;font-size:15px;line-height:1.65;color:${t.body};">${body}</p>

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${t.btn};border-radius:8px;">
                    <a href="${BASE_URL}"
                       style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:${t.btnText};text-decoration:none;border-radius:8px;">
                      ${ctaLabel}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding-top:24px;text-align:center;">
              <p style="margin:0;font-size:12px;color:${t.footer};">© 2026 ARVL</p>
              <p style="margin:4px 0 0;font-size:11px;color:${t.footer};">You're receiving this because you're a member of ARVL · Reply to unsubscribe</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Email senders ─────────────────────────────────────────

async function sendWeeklyOpener() {
  const db      = await getDb();
  const weekKey = isoWeekKey();
  const weekNum = weekNumber(weekKey);
  const members = await db.all(`SELECT username, email FROM users WHERE verified = 1`);

  console.log(`[scheduler] Sending weekly opener for ${weekKey} to ${members.length} members`);

  for (const member of members) {
    const name = member.username || member.email.split('@')[0];
    try {
      await mailer.sendMail({
        from:    `"ARVL" <${process.env.MAIL_FROM}>`,
        to:      member.email,
        subject: 'A new week is open',
        text:    `Hey ${name},\n\nWeek ${weekNum} is here. What are you listening to?\n\n→ ${BASE_URL}\n`,
        html:    buildEmail({
          eyebrow:  'Weekly pick',
          heading:  `Week ${weekNum} is open.`,
          body:     `What are you listening to this week, ${name}? Submit your pick and see what the community is into.`,
          ctaLabel: 'Submit your pick',
        }),
      });
      await db.run(`INSERT INTO email_logs (type, recipient, status) VALUES (?, ?, ?)`, ['opener', member.email, 'sent']);
    } catch (err) {
      console.error(`[scheduler] Failed to email ${member.email}:`, err.message);
      await db.run(`INSERT INTO email_logs (type, recipient, status) VALUES (?, ?, ?)`, ['opener', member.email, 'failed']).catch(() => {});
    }
  }

  console.log(`[scheduler] Weekly opener done`);
}

async function sendNudge() {
  const db      = await getDb();
  const weekKey = isoWeekKey();
  const weekNum = weekNumber(weekKey);

  const members = await db.all(
    `SELECT u.username, u.email
     FROM   users u
     WHERE  u.verified = 1
     AND    u.id NOT IN (
       SELECT r.user_id FROM recommendations r WHERE r.week_key = ?
     )`,
    weekKey
  );

  console.log(`[scheduler] Sending nudge for ${weekKey} to ${members.length} members who haven't picked`);

  for (const member of members) {
    const name = member.username || member.email.split('@')[0];
    try {
      await mailer.sendMail({
        from:    `"ARVL" <${process.env.MAIL_FROM}>`,
        to:      member.email,
        subject: "You haven't picked yet",
        text:    `Hey ${name},\n\nWeek ${weekNum} is still open. What's been on repeat?\n\n→ ${BASE_URL}\n`,
        html:    buildEmail({
          eyebrow:  'Reminder',
          heading:  "The week's still open.",
          body:     `Hey ${name}, you haven't submitted your pick for Week ${weekNum} yet. What's been on repeat? And if you need some inspiration, check out what the community is already recommending this week.`,
          ctaLabel: 'Submit your pick',
        }),
      });
      await db.run(`INSERT INTO email_logs (type, recipient, status) VALUES (?, ?, ?)`, ['nudge', member.email, 'sent']);
    } catch (err) {
      console.error(`[scheduler] Failed to email ${member.email}:`, err.message);
      await db.run(`INSERT INTO email_logs (type, recipient, status) VALUES (?, ?, ?)`, ['nudge', member.email, 'failed']).catch(() => {});
    }
  }

  console.log(`[scheduler] Nudge done`);
}

// ── Schedule ──────────────────────────────────────────────
// Monday 00:00 UTC — new week opener (fires exactly when ISO week flips)
// Wednesday 12:00 UTC — nudge (only members who haven't picked)

function start() {
  cron.schedule('0 0 * * 1', () => {
    console.log('[scheduler] Running weekly opener...');
    sendWeeklyOpener().catch(err => console.error('[scheduler] Opener error:', err.message));
  }, { timezone: 'UTC' });

  cron.schedule('0 12 * * 3', () => {
    console.log('[scheduler] Running Wednesday nudge...');
    sendNudge().catch(err => console.error('[scheduler] Nudge error:', err.message));
  }, { timezone: 'UTC' });

  console.log('[scheduler] Email reminders scheduled (Monday 00:00 UTC opener, Wednesday 12:00 UTC nudge)');
}

module.exports = { start, sendWeeklyOpener, sendNudge, buildEmail, weekNumber, isoWeekKey };
