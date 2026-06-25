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
const crypto = require('crypto');

const app = express();

// Trust proxy — required for correct IP detection behind Railway / Replit / Render load balancers
app.set('trust proxy', 1);

// ============================================================
// SECURITY HEADERS
// ============================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS — allow the custom domain, any Replit production domains, and Railway/app URL
// REPLIT_DOMAINS is a comma-separated list set automatically in Replit production deployments
// REPLIT_DEV_DOMAIN is set only in the dev workspace (different from production subdomain)
const replitProductionDomains = (process.env.REPLIT_DOMAINS || '')
  .split(',')
  .map(d => d.trim())
  .filter(Boolean)
  .map(d => `https://${d}`);

const allowedOrigins = [
  'http://localhost:5000',
  process.env.REPLIT_DEV_DOMAIN     ? `https://${process.env.REPLIT_DEV_DOMAIN}`     : null,
  process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null,
  process.env.APP_URL               ? process.env.APP_URL.replace(/\/$/, '')         : null,
  'https://eastarenagaming.com.ng',
  'https://www.eastarenagaming.com.ng',
  ...replitProductionDomains,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl / same-origin requests
    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) return cb(null, true);
    // Log blocked origins to help diagnose missing domains
    console.warn(`[CORS] Blocked origin: ${origin}. Add to APP_URL or REPLIT_DOMAINS if legitimate.`);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));

// Raw body capture for Paystack webhook (must be before express.json)
app.use('/api/webhooks/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// HEALTH CHECK — must be early, before rate limiters and auth
// ============================================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ============================================================
// ANALYTICS — persistent, survives server restarts
// ============================================================
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');
const MAX_RECENT_VIEWS = 500;
const MAX_EVENTS = 200;

function loadAnalytics() {
  try {
    if (fs.existsSync(ANALYTICS_FILE)) {
      return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[Analytics] Failed to load analytics.json:', e.message);
  }
  return { totalViews: 0, dailyCounts: {}, recentViews: [], uniqueIpHashes: [] };
}

function saveAnalytics() {
  try {
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify({
      totalViews:     analyticsStore.totalViews,
      dailyCounts:    analyticsStore.dailyCounts,
      recentViews:    analyticsStore.recentViews,
      uniqueIpHashes: [...analyticsStore.uniqueIpHashes]
    }, null, 2));
  } catch (e) {
    console.warn('[Analytics] Failed to save analytics.json:', e.message);
  }
}

// Load persisted data on boot
const _saved = loadAnalytics();
const analyticsStore = {
  totalViews:     _saved.totalViews     || 0,
  dailyCounts:    _saved.dailyCounts    || {},
  recentViews:    _saved.recentViews    || [],
  uniqueIpHashes: new Set(_saved.uniqueIpHashes || []),
  events: []
};

// Flush to disk every 30 seconds if dirty (no disk write per-request)
let _analyticsDirty = false;
setInterval(() => {
  if (_analyticsDirty) { saveAnalytics(); _analyticsDirty = false; }
}, 30_000);

function detectDevice(ua) {
  if (!ua) return 'unknown';
  if (/mobile|android|iphone|ipod/i.test(ua)) return 'mobile';
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  return 'desktop';
}
function detectBrowser(ua) {
  if (!ua) return 'unknown';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome/i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  if (/Opera|OPR/i.test(ua)) return 'Opera';
  return 'Other';
}
function hashIp(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return 'localhost';
  return crypto.createHash('md5').update(ip).digest('hex').slice(0, 10);
}
function trackPageView(req) {
  const ua      = req.headers['user-agent'] || '';
  const ip      = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  const ipHash  = hashIp(ip);
  const today   = new Date().toISOString().slice(0, 10);
  const entry   = {
    path:      req.path,
    timestamp: new Date().toISOString(),
    device:    detectDevice(ua),
    browser:   detectBrowser(ua),
    ipHash,
    referrer:  req.headers.referer || null
  };

  analyticsStore.totalViews++;
  analyticsStore.dailyCounts[today] = (analyticsStore.dailyCounts[today] || 0) + 1;
  analyticsStore.uniqueIpHashes.add(ipHash);
  analyticsStore.recentViews.unshift(entry);
  if (analyticsStore.recentViews.length > MAX_RECENT_VIEWS) analyticsStore.recentViews.pop();
  _analyticsDirty = true;
}
function trackEvent(type, meta = {}) {
  analyticsStore.events.unshift({ type, ...meta, timestamp: new Date().toISOString() });
  if (analyticsStore.events.length > MAX_EVENTS) analyticsStore.events.pop();
}

// Track page views — only HTML pages, skip API + static assets
app.use((req, res, next) => {
  if (req.method === 'GET'
    && !req.path.startsWith('/api/')
    && !/\.(js|css|png|svg|ico|jpg|webp|woff|woff2|ttf|map|json|txt)$/.test(req.path)) {
    trackPageView(req);
  }
  next();
});

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
  const user = process.env.EMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.EMAIL_PASS || process.env.SMTP_PASS;
  if (!user || !pass) return null;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587');
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

const EMAIL_FROM = process.env.EMAIL_FROM
  || (process.env.EMAIL_USER ? `East Arena Gaming <${process.env.EMAIL_USER}>` : 'East Arena Gaming <noreply@eastarena.gg>');

// Email delivery log — last 50 sends, admin-only visibility
const emailDeliveryLog = [];
const MAX_EMAIL_LOG = 50;

async function sendEmail(to, subject, html, attachments = []) {
  const mailer = createMailer();
  const logEntry = { to, subject, sentAt: new Date().toISOString(), status: 'sent', error: null };
  if (!mailer) {
    logEntry.status = 'skipped';
    logEntry.error = 'SMTP not configured';
    console.log(`[EMAIL SKIPPED] To: ${to} | Subject: ${subject}`);
    emailDeliveryLog.unshift(logEntry);
    if (emailDeliveryLog.length > MAX_EMAIL_LOG) emailDeliveryLog.pop();
    return false;
  }
  try {
    await mailer.sendMail({ from: EMAIL_FROM, to, subject, html, attachments });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
    emailDeliveryLog.unshift(logEntry);
    if (emailDeliveryLog.length > MAX_EMAIL_LOG) emailDeliveryLog.pop();
    return true;
  } catch (err) {
    logEntry.status = 'failed';
    logEntry.error = err.message;
    console.error(`[EMAIL ERROR] To: ${to} | ${err.message}`);
    emailDeliveryLog.unshift(logEntry);
    if (emailDeliveryLog.length > MAX_EMAIL_LOG) emailDeliveryLog.pop();
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
  <div class="header"><h1>🏆 EAST ARENA</h1><p>${isFree ? 'Registration Confirmed' : 'Registration Received'}</p></div>
  <div class="body">
    <h2>Welcome, ${esc(reg.playerName)}!</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 20px">Your registration for <strong style="color:#fff">${esc(tournament.name)}</strong> has been received.${isFree ? '' : ' Complete your payment to secure your spot.'}</p>
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
    isFree ? `🏆 Registration Confirmed — ${tournament.name} | Ticket ${reg.ticketId}` : `⏳ Registration Received — ${tournament.name} | Ticket ${reg.ticketId}`,
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
// PAYSTACK INTEGRATION
// ============================================================
async function paystackInitialize({ email, amountNaira, reference, callbackUrl, metadata }) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY not configured');
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      amount: amountNaira * 100, // Paystack uses kobo
      reference,
      callback_url: callbackUrl,
      currency: 'NGN',
      metadata: { custom_fields: [{ display_name: 'Ticket ID', variable_name: 'ticket_id', value: metadata.ticketId }, { display_name: 'Player', variable_name: 'player', value: metadata.playerName }, { display_name: 'Tournament', variable_name: 'tournament', value: metadata.tournament }] }
    })
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Paystack initialization failed');
  return data.data; // { authorization_url, access_code, reference }
}

async function paystackVerify(reference) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY not configured');
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { 'Authorization': `Bearer ${secret}` }
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Verification failed');
  return data.data; // { status, reference, amount, customer, ... }
}

function verifyPaystackWebhook(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !signature) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hash === signature;
}

async function confirmRegistrationPayment(ticketId, paystackRef, data) {
  const reg = data.registrations.find(r => r.ticketId === ticketId.toUpperCase());
  if (!reg || reg.paymentStatus === 'confirmed') return reg;
  reg.paymentStatus = 'confirmed';
  reg.paymentReference = paystackRef;
  reg.paystackReference = paystackRef;
  reg.paystackVerified = true;
  reg.approvedAt = new Date().toISOString();
  saveData(data);
  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
  if (tournament && reg.email) emailPaymentConfirmed(reg, tournament).catch(console.error);
  console.log(`[PAYSTACK] Payment verified and ticket confirmed: ${ticketId}`);
  return reg;
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
  if (process.env.APP_URL)               return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.REPLIT_DEV_DOMAIN)     return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL)   return process.env.RENDER_EXTERNAL_URL;
  return `http://localhost:${process.env.PORT || 5000}`;
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
  // Only expose CONFIRMED registration count to the public — pending must not appear
  const safe = visible.map(t => {
    const confirmed = data.registrations.filter(
      r => r.tournamentId === t.id && r.paymentStatus === 'confirmed'
    ).length;
    return { ...t, registrations: confirmed };
  });
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
    paymentDetails: reg.paymentStatus === 'pending' ? {
      bankName:      process.env.BANK_NAME      || null,
      accountName:   process.env.ACCOUNT_NAME   || null,
      accountNumber: process.env.ACCOUNT_NUMBER || null,
    } : null,
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

    // Track registration event
    trackEvent('registration', { ticketId, tournamentId: parseInt(tournamentId), isFree });

    // Send confirmation email (non-blocking)
    emailRegistrationConfirmation(registration, tournament).catch(console.error);

    const paymentMode     = data.settings?.paymentMode || 'manual';
    const paystackEnabled = !isFree && paymentMode === 'online' && !!(process.env.PAYSTACK_SECRET_KEY);

    res.json({
      success: true,
      message: isFree
        ? 'Registration successful! You are confirmed for this free event.'
        : 'Registration successful! Complete payment to secure your spot.',
      ticketId,
      isFree,
      paystackEnabled: isFree ? false : paystackEnabled,
      paymentInfo: isFree ? null : {
        amount: tournament.entryFee,
        bankName: process.env.BANK_NAME || 'Access Bank',
        accountName: process.env.ACCOUNT_NAME || 'East Arena Gaming',
        accountNumber: process.env.ACCOUNT_NUMBER || 'Contact admin for account details',
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

// Public settings — payment mode + bank details (safe for frontend, no secrets)
app.get('/api/public-settings', (req, res) => {
  const data = loadData();
  const paymentMode     = data.settings?.paymentMode || 'manual';
  const paystackEnabled = paymentMode === 'online' && !!(process.env.PAYSTACK_SECRET_KEY);
  res.json({
    paymentMode,
    paystackEnabled,
    bankName:      process.env.BANK_NAME      || null,
    accountName:   process.env.ACCOUNT_NAME   || null,
    accountNumber: process.env.ACCOUNT_NUMBER || null,
  });
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
  const configured = !!(process.env.EMAIL_USER || process.env.SMTP_USER);
  res.json({ configured, from: EMAIL_FROM });
});

// Admin platform settings — GET + PATCH
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const data = loadData();
  const paymentMode = data.settings?.paymentMode || 'manual';
  res.json({
    paymentMode,
    paystackConfigured: !!(process.env.PAYSTACK_SECRET_KEY),
    emailConfigured:    !!(process.env.EMAIL_USER || process.env.SMTP_USER),
    appUrl:             getAppUrl(),
    bankName:           process.env.BANK_NAME      || null,
    accountName:        process.env.ACCOUNT_NAME   || null,
    accountNumber:      process.env.ACCOUNT_NUMBER || null,
  });
});

app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  const { paymentMode } = req.body;
  if (paymentMode && !['manual', 'online'].includes(paymentMode)) {
    return res.status(400).json({ error: 'paymentMode must be "manual" or "online"' });
  }
  const data = loadData();
  if (!data.settings) data.settings = {};
  if (paymentMode !== undefined) data.settings.paymentMode = paymentMode;
  saveData(data);
  res.json({ success: true, settings: data.settings });
});

// Test email — sends a test message to the admin's own email address
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const mailer = createMailer();
  if (!mailer) {
    return res.status(400).json({ error: 'Email not configured. Add EMAIL_USER and EMAIL_PASS to Secrets.' });
  }
  const adminEmail = process.env.EMAIL_USER || process.env.SMTP_USER;
  try {
    await mailer.verify();
    const testHtml = emailBase(`<div class="card">
      <div class="header"><h1>🏆 EAST ARENA</h1><p>Email System Test</p></div>
      <div class="body">
        <h2 style="color:#34d399">✅ Email System Working!</h2>
        <p style="color:#94a3b8;font-size:14px">Your SMTP configuration is correct. Registration confirmations, payment receipts, and QR code tickets will be delivered successfully.</p>
        <div class="row"><span class="label">Tested At</span><span class="value">${new Date().toLocaleString('en-NG')}</span></div>
        <div class="row"><span class="label">Sending From</span><span class="value">${esc(EMAIL_FROM)}</span></div>
        <div class="row"><span class="label">Status</span><span class="value green">✓ Verified</span></div>
      </div>
      <div class="footer">East Arena Gaming · SMTP connection verified ✓</div>
    </div>`);
    await mailer.sendMail({ from: EMAIL_FROM, to: adminEmail, subject: '✅ East Arena — Email System Verified', html: testHtml });
    res.json({ success: true, message: `Test email sent to ${adminEmail}` });
  } catch (err) {
    res.status(500).json({ error: `SMTP test failed: ${err.message}. For Gmail, make sure you're using an App Password (not your account password).` });
  }
});

// Analytics — admin only, never exposed publicly
app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const data   = loadData();
  const regs   = data.registrations;
  const recent = analyticsStore.recentViews;
  const today  = new Date().toISOString().slice(0, 10);

  const uniqueVisitors  = analyticsStore.uniqueIpHashes.size;
  const todayViews      = analyticsStore.dailyCounts[today] || 0;
  const todayUniqueIps  = new Set(recent.filter(v => v.timestamp.startsWith(today)).map(v => v.ipHash)).size;

  const devices  = recent.reduce((a, v) => { a[v.device]  = (a[v.device]  || 0) + 1; return a; }, {});
  const browsers = recent.reduce((a, v) => { a[v.browser] = (a[v.browser] || 0) + 1; return a; }, {});

  const pathCounts = recent.reduce((a, v) => { a[v.path] = (a[v.path] || 0) + 1; return a; }, {});
  const topPages   = Object.entries(pathCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count }));

  const confirmedRegs  = regs.filter(r => r.paymentStatus === 'confirmed').length;
  const conversionRate = uniqueVisitors > 0 ? (regs.length / uniqueVisitors * 100).toFixed(1) : '0.0';

  const recentRegs = regs.slice().sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt)).slice(0, 20).map(r => {
    const t = data.tournaments.find(t => t.id === r.tournamentId);
    return { playerName: r.playerName, gamertag: r.gamertag, tournamentName: t?.name || 'Unknown', paymentStatus: r.paymentStatus, registeredAt: r.registeredAt };
  });

  res.json({
    summary: {
      totalPageViews:      analyticsStore.totalViews,
      uniqueVisitors,
      todayPageViews:      todayViews,
      todayUniqueVisitors: todayUniqueIps,
      totalRegistrations:  regs.length,
      confirmedRegistrations: confirmedRegs,
      conversionRate,
      emailConfigured:     !!(process.env.EMAIL_USER || process.env.SMTP_USER),
    },
    devices,
    browsers,
    topPages,
    recentViews:         recent.slice(0, 50),
    recentRegistrations: recentRegs,
    emailLog:            emailDeliveryLog.slice(0, 30),
    events:              analyticsStore.events.slice(0, 50),
  });
});

// ============================================================
// PAYSTACK PAYMENT ROUTES
// ============================================================

// Initialize Paystack payment — secret key stays on server, never sent to frontend
app.post('/api/payment/initialize', registrationLimiter, async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'Ticket ID required' });

  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(400).json({ error: 'Online payment is not configured. Please use bank transfer.' });
  }

  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === ticketId.toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  if (reg.paymentStatus === 'confirmed') return res.status(400).json({ error: 'Payment is already confirmed.' });
  if (reg.paymentStatus === 'rejected') return res.status(400).json({ error: 'This registration was rejected. Please re-register.' });

  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  if (tournament.entryFee === 0) return res.status(400).json({ error: 'This is a free event.' });

  try {
    const callbackUrl = `${getAppUrl()}/payment/callback`;
    const ps = await paystackInitialize({
      email: reg.email,
      amountNaira: tournament.entryFee,
      reference: reg.ticketId, // ticketId is our Paystack reference
      callbackUrl,
      metadata: { ticketId: reg.ticketId, playerName: reg.playerName, tournament: tournament.name }
    });
    res.json({ success: true, authorization_url: ps.authorization_url, reference: ps.reference });
  } catch (err) {
    console.error('[PAYSTACK INIT ERROR]', err.message);
    res.status(500).json({ error: 'Could not initialize payment. Please try bank transfer or contact support.' });
  }
});

// Paystack callback — user is redirected here after paying on Paystack's page
app.get('/payment/callback', async (req, res) => {
  const reference = req.query.reference || req.query.trxref;
  if (!reference) return res.redirect('/?payment=missing_reference');

  try {
    const transaction = await paystackVerify(reference);

    if (transaction.status !== 'success') {
      // Payment was cancelled or failed — send back to ticket page in pending state
      const data = loadData();
      const reg = data.registrations.find(r => r.ticketId === reference.toUpperCase());
      const dest = reg ? `/ticket/${reg.ticketId}?payment=cancelled` : '/?payment=failed';
      return res.redirect(dest);
    }

    const data = loadData();
    const reg = await confirmRegistrationPayment(reference, transaction.reference, data);
    if (!reg) return res.redirect('/?error=ticket_not_found');

    res.redirect(`/ticket/${reg.ticketId}?payment=success`);
  } catch (err) {
    console.error('[PAYSTACK CALLBACK ERROR]', err.message);
    res.redirect('/?error=payment_verification_failed');
  }
});

// Paystack webhook — fires independently of browser redirect, ensures reliability
// Paystack retries this for up to 24h if it fails. Always respond 200 quickly.
app.post('/api/webhooks/paystack', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately
  const signature = req.headers['x-paystack-signature'];
  if (!verifyPaystackWebhook(req.body, signature)) {
    console.warn('[PAYSTACK WEBHOOK] Invalid signature — ignoring');
    return;
  }
  try {
    const event = JSON.parse(req.body.toString());
    if (event.event === 'charge.success' && event.data?.status === 'success') {
      const reference = event.data.reference;
      const data = loadData();
      await confirmRegistrationPayment(reference, reference, data);
    }
  } catch (err) {
    console.error('[PAYSTACK WEBHOOK ERROR]', err.message);
  }
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
// PROCESS STABILITY — prevent crashes from unhandled errors
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Log but do not crash — keeps the server alive for other requests
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  // Flush analytics then exit — let the process manager restart us
  if (_analyticsDirty) { try { saveAnalytics(); } catch (_) {} }
  process.exit(1);
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ East Arena Gaming Tournament — http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
  const emailUser = process.env.EMAIL_USER || process.env.SMTP_USER;
  console.log(`  Email: ${emailUser ? `configured ✓ (${emailUser})` : 'NOT configured'}`);
  console.log(`  Payment mode: ${(loadData().settings?.paymentMode || 'manual')}`);
});

// ============================================================
// GRACEFUL SHUTDOWN — required for autoscale SIGTERM
// ============================================================
function shutdown(signal) {
  console.log(`[${signal}] Graceful shutdown started…`);
  // Flush any pending analytics immediately before exit
  if (_analyticsDirty) {
    try { saveAnalytics(); console.log('[Shutdown] Analytics flushed.'); }
    catch (e) { console.warn('[Shutdown] Analytics flush failed:', e.message); }
  }
  server.close(() => {
    console.log('[Shutdown] HTTP server closed. Exiting.');
    process.exit(0);
  });
  // Force-exit after 10 s if connections hang
  setTimeout(() => {
    console.warn('[Shutdown] Timeout — forcing exit.');
    process.exit(0);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
