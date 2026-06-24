require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();

// ============================================================
// SECURITY HEADERS
// ============================================================
app.use(helmet({
  contentSecurityPolicy: false, // Allow CDN scripts
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// RATE LIMITING
// ============================================================
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many registration attempts. Please try again in 15 minutes.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again later.' }
});

// ============================================================
// CONFIG
// ============================================================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DATA_FILE = path.join(__dirname, 'data.json');

// In-memory session store (acceptable for single-instance; survives until restart)
const sessions = new Set();

// ============================================================
// EMAIL SETUP
// ============================================================
function createMailer() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass }
  });
}

const EMAIL_FROM = process.env.EMAIL_FROM || 'East Arena Gaming <noreply@eastarena.gg>';

async function sendEmail(to, subject, html, attachments = []) {
  const mailer = createMailer();
  if (!mailer) {
    console.log(`[EMAIL SKIPPED — SMTP not configured] To: ${to} | Subject: ${subject}`);
    return false;
  }
  try {
    await mailer.sendMail({ from: EMAIL_FROM, to, subject, html, attachments });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[EMAIL ERROR] To: ${to} | ${err.message}`);
    return false;
  }
}

// ── Email Templates ───────────────────────────────────────
function emailBase(content) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#0F1419;font-family:system-ui,sans-serif;color:#fff}
  .wrap{max-width:560px;margin:0 auto;padding:20px}
  .card{background:#1E2530;border-radius:16px;overflow:hidden;border:1px solid #f59e0b33}
  .header{background:linear-gradient(135deg,#d97706,#f59e0b);padding:32px 24px;text-align:center}
  .header h1{margin:0;font-size:28px;font-weight:900;color:#0F1419;letter-spacing:-0.5px}
  .header p{margin:6px 0 0;font-size:13px;color:#0F1419;opacity:.8;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
  .body{padding:28px 24px}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #ffffff11;font-size:14px}
  .row:last-child{border:none}
  .label{color:#94a3b8}
  .value{font-weight:700;color:#fff;text-align:right}
  .value.gold{color:#f59e0b;font-family:monospace;font-size:18px;letter-spacing:.08em}
  .value.green{color:#34d399}
  .value.red{color:#f87171}
  .btn{display:block;background:#f59e0b;color:#0F1419;text-decoration:none;font-weight:900;font-size:15px;padding:14px 24px;border-radius:10px;text-align:center;margin:20px 0}
  .footer{background:#0F1419;padding:16px 24px;text-align:center;color:#475569;font-size:12px}
  .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .badge-green{background:#065f46;color:#34d399}
  .badge-yellow{background:#78350f;color:#fcd34d}
  .badge-red{background:#7f1d1d;color:#fca5a5}
  .qr-wrap{text-align:center;padding:16px 0}
  .qr-wrap img{width:180px;height:180px;border-radius:8px}
  .highlight{background:#f59e0b1a;border:1px solid #f59e0b33;border-radius:10px;padding:14px 16px;margin:16px 0}
  h2{color:#f59e0b;margin:0 0 16px;font-size:18px}
</style></head>
<body><div class="wrap">${content}
<p style="text-align:center;color:#334155;font-size:11px;margin-top:12px">East Arena Gaming © 2026 · Premium Tournament Platform</p>
</div></body></html>`;
}

async function emailRegistrationConfirmation(reg, tournament) {
  const isFree = tournament.entryFee === 0;
  const ticketUrl = getAppUrl() + '/ticket/' + reg.ticketId;
  const qrBuffer = await QRCode.toBuffer(ticketUrl, { width: 300, margin: 2 });

  const content = `<div class="card">
  <div class="header"><h1>🏆 EAST ARENA</h1><p>Registration Confirmed</p></div>
  <div class="body">
    <h2>Welcome, ${esc(reg.playerName)}!</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 20px">Your registration for <strong style="color:#fff">${esc(tournament.name)}</strong> has been received.</p>
    <div>
      <div class="row"><span class="label">Ticket ID</span><span class="value gold">${reg.ticketId}</span></div>
      <div class="row"><span class="label">Player Name</span><span class="value">${esc(reg.playerName)}</span></div>
      <div class="row"><span class="label">Gaming Name</span><span class="value" style="color:#f59e0b">@${esc(reg.gamertag)}</span></div>
      <div class="row"><span class="label">Tournament</span><span class="value">${esc(tournament.name)}</span></div>
      <div class="row"><span class="label">Game</span><span class="value">${esc(tournament.game)}</span></div>
      <div class="row"><span class="label">Date</span><span class="value">${new Date(tournament.date).toLocaleDateString('en-NG',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="row"><span class="label">Entry Fee</span><span class="value" style="color:#34d399">${isFree ? 'FREE' : '₦' + Number(tournament.entryFee).toLocaleString()}</span></div>
      <div class="row"><span class="label">Payment Status</span><span class="value"><span class="badge ${isFree ? 'badge-green' : 'badge-yellow'}">${isFree ? 'Confirmed — Free Event' : 'Pending Payment'}</span></span></div>
    </div>
    ${!isFree ? `<div class="highlight">
      <p style="margin:0 0 10px;font-size:13px;color:#fcd34d;font-weight:700">⚠ PAYMENT REQUIRED</p>
      <p style="margin:0;font-size:13px;color:#94a3b8">Transfer <strong style="color:#fff">₦${Number(tournament.entryFee).toLocaleString()}</strong> to the bank account provided on your ticket page. Use your Ticket ID <strong style="color:#f59e0b">${reg.ticketId}</strong> as the transfer narration.</p>
    </div>` : ''}
    <div class="qr-wrap">
      <p style="color:#64748b;font-size:12px;margin:0 0 10px">Your tournament QR ticket</p>
      <img src="cid:qrcode" alt="QR Code" />
      <p style="color:#64748b;font-size:11px;margin:10px 0 0">Show this at the venue entrance</p>
    </div>
    <a href="${ticketUrl}" class="btn">View My Full Ticket →</a>
  </div>
  <div class="footer">East Arena Gaming · Questions? Contact us at the venue.</div>
</div>`;

  await sendEmail(
    reg.email,
    `🏆 Registration Confirmed — ${tournament.name} | Ticket ${reg.ticketId}`,
    emailBase(content),
    [{ filename: 'ticket-qr.png', content: qrBuffer, cid: 'qrcode' }]
  );
}

async function emailPaymentConfirmed(reg, tournament) {
  const ticketUrl = getAppUrl() + '/ticket/' + reg.ticketId;
  const qrBuffer = await QRCode.toBuffer(ticketUrl, { width: 300, margin: 2 });

  const content = `<div class="card">
  <div class="header"><h1>🏆 EAST ARENA</h1><p>Payment Confirmed</p></div>
  <div class="body">
    <h2>✅ Your Spot is Secured!</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 20px">Your payment for <strong style="color:#fff">${esc(tournament.name)}</strong> has been confirmed. You are officially registered!</p>
    <div>
      <div class="row"><span class="label">Ticket ID</span><span class="value gold">${reg.ticketId}</span></div>
      <div class="row"><span class="label">Player</span><span class="value">${esc(reg.playerName)}</span></div>
      <div class="row"><span class="label">Gaming Name</span><span class="value" style="color:#f59e0b">@${esc(reg.gamertag)}</span></div>
      <div class="row"><span class="label">Tournament</span><span class="value">${esc(tournament.name)}</span></div>
      <div class="row"><span class="label">Date</span><span class="value">${new Date(tournament.date).toLocaleDateString('en-NG',{day:'numeric',month:'long',year:'numeric'})}</span></div>
      <div class="row"><span class="label">Prize Pool</span><span class="value green">₦${Number(tournament.prizePool.first + tournament.prizePool.second + tournament.prizePool.third).toLocaleString()}</span></div>
      <div class="row"><span class="label">Status</span><span class="value"><span class="badge badge-green">✓ CONFIRMED</span></span></div>
    </div>
    <div class="qr-wrap">
      <p style="color:#64748b;font-size:12px;margin:0 0 10px">Your entry QR code — show at venue</p>
      <img src="cid:qrcode" alt="QR Code" />
    </div>
    <a href="${ticketUrl}" class="btn">View My Ticket →</a>
    <p style="font-size:12px;color:#475569;text-align:center;margin-top:8px">Save this email. Bring your QR code to the venue.</p>
  </div>
  <div class="footer">East Arena Gaming · Good luck at the tournament! 🎮</div>
</div>`;

  await sendEmail(
    reg.email,
    `✅ Payment Confirmed — ${tournament.name} | You're In!`,
    emailBase(content),
    [{ filename: 'ticket-qr.png', content: qrBuffer, cid: 'qrcode' }]
  );
}

async function emailPaymentRejected(reg, tournament) {
  const content = `<div class="card">
  <div class="header" style="background:linear-gradient(135deg,#7f1d1d,#dc2626)"><h1>🏆 EAST ARENA</h1><p style="color:#fca5a5">Payment Notice</p></div>
  <div class="body">
    <h2 style="color:#f87171">Payment Not Accepted</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 20px">Unfortunately, your payment reference for <strong style="color:#fff">${esc(tournament.name)}</strong> could not be verified.</p>
    <div>
      <div class="row"><span class="label">Ticket ID</span><span class="value gold">${reg.ticketId}</span></div>
      <div class="row"><span class="label">Player</span><span class="value">${esc(reg.playerName)}</span></div>
      <div class="row"><span class="label">Reference Submitted</span><span class="value">${esc(reg.paymentReference || '—')}</span></div>
      <div class="row"><span class="label">Status</span><span class="value"><span class="badge badge-red">✗ REJECTED</span></span></div>
    </div>
    <div class="highlight" style="border-color:#f8717133;background:#f871711a">
      <p style="margin:0;font-size:13px;color:#fca5a5">If you believe this is an error, please contact us with your bank receipt and Ticket ID. You may re-register if spots are still available.</p>
    </div>
  </div>
  <div class="footer">East Arena Gaming · Contact us to resolve payment issues.</div>
</div>`;

  await sendEmail(
    reg.email,
    `Payment Notice — ${tournament.name} | Action Required`,
    emailBase(content)
  );
}

async function emailEventReminder(reg, tournament) {
  const ticketUrl = getAppUrl() + '/ticket/' + reg.ticketId;
  const qrBuffer = await QRCode.toBuffer(ticketUrl, { width: 300, margin: 2 });

  const content = `<div class="card">
  <div class="header"><h1>🏆 EAST ARENA</h1><p>Event Reminder</p></div>
  <div class="body">
    <h2>⏰ Tournament is Tomorrow!</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 20px">This is a reminder for <strong style="color:#fff">${esc(tournament.name)}</strong>. Make sure you are ready!</p>
    <div>
      <div class="row"><span class="label">Ticket ID</span><span class="value gold">${reg.ticketId}</span></div>
      <div class="row"><span class="label">Player</span><span class="value">${esc(reg.playerName)}</span></div>
      <div class="row"><span class="label">Gaming Name</span><span class="value" style="color:#f59e0b">@${esc(reg.gamertag)}</span></div>
      <div class="row"><span class="label">Date</span><span class="value green">${new Date(tournament.date).toLocaleDateString('en-NG',{day:'numeric',month:'long',year:'numeric'})}</span></div>
    </div>
    ${tournament.twitchLink ? `<div class="highlight"><p style="margin:0;font-size:13px;color:#94a3b8">Watch the stream: <a href="${esc(tournament.twitchLink)}" style="color:#f59e0b">${esc(tournament.twitchLink)}</a></p></div>` : ''}
    <div class="qr-wrap">
      <p style="color:#64748b;font-size:12px;margin:0 0 10px">Bring this QR code to the venue</p>
      <img src="cid:qrcode" alt="QR Code" />
    </div>
    <a href="${ticketUrl}" class="btn">View My Ticket →</a>
  </div>
  <div class="footer">East Arena Gaming · See you at the tournament! 🎮</div>
</div>`;

  await sendEmail(
    reg.email,
    `⏰ Tomorrow is the Day! — ${tournament.name} Reminder`,
    emailBase(content),
    [{ filename: 'ticket-qr.png', content: qrBuffer, cid: 'qrcode' }]
  );
}

// ============================================================
// DATA HELPERS
// ============================================================
const defaultData = () => ({
  settings: {},
  announcements: [],
  tournaments: [
    {
      id: 1,
      name: 'East Arena Championship S1',
      game: 'FIFA',
      date: '2026-09-20',
      entryFee: 30000,
      prizePool: { first: 150000, second: 80000, third: 40000 },
      status: 'active',
      twitchLink: 'https://twitch.tv/eastarena',
      maxPlayers: 16,
      registrations: [],
      description: 'Premium FIFA tournament. Entry fee required. Real prize money.'
    },
    {
      id: 2,
      name: 'Call of Duty — Open Session',
      game: 'CODM',
      date: '2026-08-10',
      entryFee: 0,
      prizePool: { first: 0, second: 0, third: 0 },
      status: 'upcoming',
      twitchLink: '',
      maxPlayers: 32,
      registrations: [],
      description: 'Free Call of Duty Mobile session. Open to all skill levels.'
    },
    {
      id: 3,
      name: 'Mortal Kombat — Open Session',
      game: 'Mortal Kombat',
      date: '2026-08-17',
      entryFee: 0,
      prizePool: { first: 0, second: 0, third: 0 },
      status: 'upcoming',
      twitchLink: '',
      maxPlayers: 24,
      registrations: [],
      description: 'Free Mortal Kombat casual session. All welcome.'
    },
    {
      id: 4,
      name: 'Casual Gaming Night',
      game: 'Casual',
      date: '2026-08-03',
      entryFee: 0,
      prizePool: { first: 0, second: 0, third: 0 },
      status: 'upcoming',
      twitchLink: '',
      maxPlayers: 50,
      registrations: [],
      description: 'Mixed casual gaming night. Multiple games, no pressure, just fun.'
    }
  ],
  registrations: []
});

const loadData = () => {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!parsed.settings) parsed.settings = {};
      if (!parsed.announcements) parsed.announcements = [];
      return parsed;
    } catch (e) {
      return defaultData();
    }
  }
  return defaultData();
};

const saveData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

function getAdminPassword() {
  const data = loadData();
  return data.settings?.adminPassword || process.env.ADMIN_PASSWORD || 'eastarena2026';
}

function getAppUrl() {
  return process.env.APP_URL
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
    || process.env.RENDER_EXTERNAL_URL
    || `http://localhost:${process.env.PORT || 5000}`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
const requireAdmin = (req, res, next) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ============================================================
// ADMIN AUTH ROUTES
// ============================================================
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === getAdminPassword()) {
    const token = uuidv4();
    sessions.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ success: true });
});

app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ authenticated: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (currentPassword !== getAdminPassword()) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  const data = loadData();
  data.settings.adminPassword = newPassword;
  saveData(data);
  sessions.clear();
  res.json({ success: true, message: 'Password updated. Please log in again.' });
});

// ============================================================
// PUBLIC ROUTES
// ============================================================
app.get('/api/tournaments', (req, res) => {
  const data = loadData();
  const visible = data.tournaments.filter(t => t.status === 'active' || t.status === 'upcoming');
  // Return registration count (not full IDs)
  const safe = visible.map(t => ({ ...t, registrations: t.registrations.length }));
  res.json(safe);
});

app.get('/api/ticket/:ticketId', async (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId.toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });

  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);

  // Generate QR on demand (do not store in JSON)
  const ticketUrl = `${getAppUrl()}/ticket/${reg.ticketId}`;
  let qrCode = '';
  try {
    qrCode = await QRCode.toDataURL(ticketUrl, { width: 300, margin: 2 });
  } catch (_) {}

  const { qrCode: _removed, ...regClean } = reg;
  res.json({
    ...regClean,
    qrCode,
    tournament: tournament
      ? { name: tournament.name, date: tournament.date, twitchLink: tournament.twitchLink, entryFee: tournament.entryFee, game: tournament.game }
      : null
  });
});

app.post('/api/register', registrationLimiter, async (req, res) => {
  try {
    const { playerName, gamertag, phone, email, location, tournamentId } = req.body;

    if (!playerName || !gamertag || !phone || !email || !location || !tournamentId) {
      return res.status(400).json({ error: 'All fields are required (name, gaming tag, phone, email, location, tournament)' });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const data = loadData();
    const tournament = data.tournaments.find(t => t.id === parseInt(tournamentId));
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (tournament.status !== 'active' && tournament.status !== 'upcoming') {
      return res.status(400).json({ error: 'This tournament is not currently accepting registrations' });
    }

    // Capacity check (only count non-rejected)
    const activeRegs = data.registrations.filter(
      r => r.tournamentId === parseInt(tournamentId) && r.paymentStatus !== 'rejected'
    );
    if (activeRegs.length >= tournament.maxPlayers) {
      return res.status(400).json({ error: `Tournament is full (maximum ${tournament.maxPlayers} players)` });
    }

    // Duplicate check
    const duplicate = data.registrations.find(r =>
      r.tournamentId === parseInt(tournamentId) &&
      r.paymentStatus !== 'rejected' &&
      (r.gamertag.toLowerCase() === gamertag.toLowerCase() ||
       r.phone === phone ||
       (r.email && r.email.toLowerCase() === email.toLowerCase()))
    );
    if (duplicate) {
      return res.status(400).json({ error: 'A player with this gamer tag, phone, or email is already registered for this tournament' });
    }

    const ticketId = uuidv4().slice(0, 8).toUpperCase();
    const isFree = tournament.entryFee === 0;

    const registration = {
      id: uuidv4(),
      ticketId,
      playerName: playerName.trim(),
      gamertag: gamertag.trim(),
      phone: phone.trim(),
      email: email.trim().toLowerCase(),
      location: location.trim(),
      tournamentId: parseInt(tournamentId),
      paymentStatus: isFree ? 'confirmed' : 'pending',
      paymentReference: isFree ? 'FREE_EVENT' : null,
      referenceSubmittedAt: isFree ? new Date().toISOString() : null,
      checkedIn: false,
      checkedInAt: null,
      approvedAt: isFree ? new Date().toISOString() : null,
      rejectedAt: null,
      registeredAt: new Date().toISOString()
    };

    data.registrations.push(registration);
    tournament.registrations.push(registration.id);
    saveData(data);

    // Send confirmation email (non-blocking)
    emailRegistrationConfirmation(registration, tournament).catch(console.error);

    const paymentProvider = process.env.PAYMENT_PROVIDER || 'manual';

    res.json({
      success: true,
      message: isFree
        ? 'Registration successful! You are confirmed for this free event.'
        : 'Registration successful! Follow the payment instructions to secure your spot.',
      ticketId,
      isFree,
      paymentProvider: isFree ? 'free' : paymentProvider,
      paymentInfo: isFree ? null : {
        amount: tournament.entryFee,
        bankName: process.env.BANK_NAME || 'Access Bank',
        accountName: process.env.ACCOUNT_NAME || 'East Arena Gaming',
        accountNumber: process.env.ACCOUNT_NUMBER || '0123456789',
        reference: ticketId
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/submit-payment', (req, res) => {
  const { ticketId, paymentReference } = req.body;
  if (!ticketId || !paymentReference) {
    return res.status(400).json({ error: 'Ticket ID and payment reference are required' });
  }
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === ticketId.toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  if (reg.paymentStatus === 'confirmed') {
    return res.status(400).json({ error: 'Payment is already confirmed' });
  }
  if (reg.paymentStatus === 'rejected') {
    return res.status(400).json({ error: 'This registration was rejected. Please contact support.' });
  }
  reg.paymentReference = paymentReference.trim();
  reg.referenceSubmittedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true, message: 'Payment reference submitted. An admin will review and approve it shortly.' });
});

// Ticket lookup by email (for user dashboard)
app.post('/api/lookup', (req, res) => {
  const { email, ticketId } = req.body;
  if (!email && !ticketId) {
    return res.status(400).json({ error: 'Provide your email address or ticket ID' });
  }
  const data = loadData();
  let regs = [];
  if (ticketId) {
    const r = data.registrations.find(r => r.ticketId === ticketId.toUpperCase());
    if (r) regs = [r];
  } else if (email) {
    regs = data.registrations.filter(r => r.email && r.email.toLowerCase() === email.toLowerCase().trim());
  }
  if (!regs.length) return res.status(404).json({ error: 'No registrations found' });

  const result = regs.map(r => {
    const t = data.tournaments.find(t => t.id === r.tournamentId);
    const { qrCode: _, ...clean } = r;
    return { ...clean, tournament: t ? { name: t.name, date: t.date, game: t.game, entryFee: t.entryFee } : null };
  });
  res.json(result);
});

// Public announcements
app.get('/api/announcements', (req, res) => {
  const data = loadData();
  const active = (data.announcements || []).filter(a => a.active).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(active);
});

// ============================================================
// ADMIN ROUTES (protected)
// ============================================================
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const data = loadData();
  const regs = data.registrations;
  const confirmed = regs.filter(r => r.paymentStatus === 'confirmed');
  const pending   = regs.filter(r => r.paymentStatus === 'pending');
  const rejected  = regs.filter(r => r.paymentStatus === 'rejected');

  const revenue = confirmed.reduce((sum, r) => {
    const t = data.tournaments.find(t => t.id === r.tournamentId);
    return sum + (t && t.entryFee > 0 ? t.entryFee : 0);
  }, 0);

  // Revenue by tournament
  const byTournament = data.tournaments.map(t => {
    const tRegs = confirmed.filter(r => r.tournamentId === t.id);
    return { name: t.name, game: t.game, confirmed: tRegs.length, revenue: tRegs.length * t.entryFee };
  });

  res.json({
    total: regs.length,
    confirmed: confirmed.length,
    pending: pending.length,
    rejected: rejected.length,
    checkedIn: regs.filter(r => r.checkedIn).length,
    revenue,
    tournaments: data.tournaments.length,
    byTournament
  });
});

app.get('/api/admin/registrations', requireAdmin, (req, res) => {
  const data = loadData();
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status || '';
  const tournamentId = req.query.tournamentId || '';

  let regs = data.registrations.map(r => {
    const t = data.tournaments.find(t => t.id === r.tournamentId);
    const { qrCode: _, ...clean } = r;
    return { ...clean, tournamentName: t ? t.name : 'Unknown', game: t?.game || '' };
  });

  if (status) regs = regs.filter(r => r.paymentStatus === status);
  if (tournamentId) regs = regs.filter(r => String(r.tournamentId) === tournamentId);
  if (search) {
    regs = regs.filter(r =>
      r.playerName.toLowerCase().includes(search) ||
      r.gamertag.toLowerCase().includes(search) ||
      r.ticketId.toLowerCase().includes(search) ||
      r.phone.includes(search) ||
      (r.email || '').toLowerCase().includes(search) ||
      (r.paymentReference || '').toLowerCase().includes(search)
    );
  }

  regs.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
  res.json(regs);
});

app.post('/api/admin/approve/:ticketId', requireAdmin, async (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  if (reg.paymentStatus === 'confirmed') return res.status(400).json({ error: 'Already confirmed' });
  reg.paymentStatus = 'confirmed';
  reg.approvedAt = new Date().toISOString();
  saveData(data);

  // Send payment confirmed email
  if (reg.email) {
    const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
    if (tournament) emailPaymentConfirmed(reg, tournament).catch(console.error);
  }

  res.json({ success: true });
});

app.post('/api/admin/reject/:ticketId', requireAdmin, async (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  reg.paymentStatus = 'rejected';
  reg.rejectedAt = new Date().toISOString();
  saveData(data);

  if (reg.email) {
    const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
    if (tournament) emailPaymentRejected(reg, tournament).catch(console.error);
  }

  res.json({ success: true });
});

app.post('/api/admin/checkin/:ticketId', requireAdmin, (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId.toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  if (reg.paymentStatus !== 'confirmed') {
    return res.status(400).json({ error: 'Cannot check in — payment not yet confirmed' });
  }
  if (reg.checkedIn) {
    return res.status(400).json({ error: 'Already checked in', alreadyCheckedIn: true, player: reg.playerName, time: reg.checkedInAt });
  }
  reg.checkedIn = true;
  reg.checkedInAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true, player: reg.playerName, gamertag: reg.gamertag, tournament: data.tournaments.find(t => t.id === reg.tournamentId)?.name });
});

// QR scan endpoint (for venue scanner — same as checkin but returns richer response)
app.post('/api/admin/scan', requireAdmin, (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'Ticket ID required' });
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === ticketId.toUpperCase());

  if (!reg) return res.status(404).json({ error: 'Ticket not found', status: 'not_found' });

  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);

  if (reg.paymentStatus !== 'confirmed') {
    return res.status(400).json({
      error: 'Payment not confirmed',
      status: 'unconfirmed',
      player: reg.playerName,
      gamertag: reg.gamertag,
      paymentStatus: reg.paymentStatus
    });
  }

  if (reg.checkedIn) {
    return res.status(400).json({
      error: 'Already checked in',
      status: 'duplicate',
      player: reg.playerName,
      gamertag: reg.gamertag,
      checkedInAt: reg.checkedInAt
    });
  }

  reg.checkedIn = true;
  reg.checkedInAt = new Date().toISOString();
  saveData(data);

  res.json({
    success: true,
    status: 'checked_in',
    player: reg.playerName,
    gamertag: reg.gamertag,
    ticketId: reg.ticketId,
    tournament: tournament?.name,
    checkedInAt: reg.checkedInAt
  });
});

app.delete('/api/admin/player/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const idx = data.registrations.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Player not found' });
  const reg = data.registrations[idx];
  const t = data.tournaments.find(t => t.id === reg.tournamentId);
  if (t) t.registrations = t.registrations.filter(id => id !== reg.id);
  data.registrations.splice(idx, 1);
  saveData(data);
  res.json({ success: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const data = loadData();
  const timestamp = new Date().toISOString().slice(0, 10);
  // Strip QR codes from export to keep file size manageable
  const exportData = {
    ...data,
    registrations: data.registrations.map(r => { const { qrCode: _, ...clean } = r; return clean; })
  };
  res.setHeader('Content-Disposition', `attachment; filename=east-arena-backup-${timestamp}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(exportData, null, 2));
});

// Send reminder emails to confirmed players of a tournament
app.post('/api/admin/send-reminders/:tournamentId', requireAdmin, async (req, res) => {
  const data = loadData();
  const tournament = data.tournaments.find(t => t.id === parseInt(req.params.tournamentId));
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

  const confirmed = data.registrations.filter(r => r.tournamentId === tournament.id && r.paymentStatus === 'confirmed' && r.email);
  if (confirmed.length === 0) return res.json({ success: true, sent: 0, message: 'No confirmed players with email addresses' });

  // Send in background
  Promise.all(confirmed.map(r => emailEventReminder(r, tournament))).catch(console.error);
  res.json({ success: true, sent: confirmed.length, message: `Sending reminder emails to ${confirmed.length} player(s)` });
});

// Tournament management
app.get('/api/admin/tournaments', requireAdmin, (req, res) => {
  const data = loadData();
  res.json(data.tournaments);
});

app.post('/api/admin/tournaments', requireAdmin, (req, res) => {
  const { name, game, date, entryFee, prizePoolFirst, prizePoolSecond, prizePoolThird, maxPlayers, twitchLink, status, description } = req.body;
  if (!name || !date) {
    return res.status(400).json({ error: 'Name and date are required' });
  }
  const data = loadData();
  const newId = data.tournaments.length > 0 ? Math.max(...data.tournaments.map(t => t.id)) + 1 : 1;
  const tournament = {
    id: newId,
    name,
    game: game || 'FIFA',
    date,
    entryFee: parseInt(entryFee) || 0,
    prizePool: {
      first:  parseInt(prizePoolFirst)  || 0,
      second: parseInt(prizePoolSecond) || 0,
      third:  parseInt(prizePoolThird)  || 0
    },
    status: status || 'active',
    twitchLink: twitchLink || '',
    maxPlayers: parseInt(maxPlayers) || 16,
    registrations: [],
    description: description || ''
  };
  data.tournaments.push(tournament);
  saveData(data);
  res.json({ success: true, tournament });
});

app.put('/api/admin/tournaments/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const t = data.tournaments.find(t => t.id === parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const { name, game, date, entryFee, prizePoolFirst, prizePoolSecond, prizePoolThird, maxPlayers, twitchLink, status, description } = req.body;
  if (name !== undefined)           t.name       = name;
  if (game !== undefined)           t.game       = game;
  if (date !== undefined)           t.date       = date;
  if (entryFee !== undefined)       t.entryFee   = parseInt(entryFee) || 0;
  if (prizePoolFirst !== undefined)  t.prizePool.first  = parseInt(prizePoolFirst)  || 0;
  if (prizePoolSecond !== undefined) t.prizePool.second = parseInt(prizePoolSecond) || 0;
  if (prizePoolThird !== undefined)  t.prizePool.third  = parseInt(prizePoolThird)  || 0;
  if (maxPlayers !== undefined)     t.maxPlayers = parseInt(maxPlayers);
  if (twitchLink !== undefined)     t.twitchLink = twitchLink;
  if (status !== undefined)         t.status     = status;
  if (description !== undefined)    t.description = description;
  saveData(data);
  res.json({ success: true, tournament: t });
});

app.delete('/api/admin/tournaments/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const idx = data.tournaments.findIndex(t => t.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Tournament not found' });
  data.tournaments.splice(idx, 1);
  saveData(data);
  res.json({ success: true });
});

// Announcements
app.get('/api/admin/announcements', requireAdmin, (req, res) => {
  const data = loadData();
  res.json((data.announcements || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  const { title, message, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  const data = loadData();
  if (!data.announcements) data.announcements = [];
  const ann = { id: uuidv4(), title, message, type: type || 'info', active: true, createdAt: new Date().toISOString() };
  data.announcements.unshift(ann);
  saveData(data);
  res.json({ success: true, announcement: ann });
});

app.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const data = loadData();
  if (!data.announcements) return res.status(404).json({ error: 'Not found' });
  const idx = data.announcements.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Announcement not found' });
  data.announcements.splice(idx, 1);
  saveData(data);
  res.json({ success: true });
});

// Email config status (admin only)
app.get('/api/admin/email-status', requireAdmin, (req, res) => {
  res.json({
    configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    from: EMAIL_FROM
  });
});

// ============================================================
// PAGE ROUTES
// ============================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/ticket/:ticketId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ticket.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ East Arena Gaming Tournament — http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
  console.log(`  Default admin password: ${getAdminPassword()}`);
  console.log(`  Email: ${process.env.SMTP_HOST ? 'configured' : 'NOT configured (emails will be skipped)'}`);
});
