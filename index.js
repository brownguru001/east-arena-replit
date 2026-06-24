const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// CONFIG
// ============================================================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DATA_FILE = path.join(__dirname, 'data.json');

// In-memory session store
const sessions = new Set();

// ============================================================
// DATA HELPERS
// ============================================================
const defaultData = () => ({
  settings: {},
  tournaments: [
    {
      id: 1,
      name: 'East Arena Championship S1',
      game: 'FIFA',
      date: '2024-07-20',
      entryFee: 30000,
      prizePool: { first: 150000, second: 80000, third: 40000 },
      status: 'active',
      twitchLink: 'https://twitch.tv/eastarena',
      maxPlayers: 16,
      registrations: []
    }
  ],
  registrations: []
});

const loadData = () => {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!parsed.settings) parsed.settings = {};
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

// Password resolution:
// 1. data.settings.adminPassword (set via change-password feature) takes priority
// 2. ADMIN_PASSWORD env var
// 3. hard fallback (never exposed in code now)
function getAdminPassword() {
  const data = loadData();
  return data.settings?.adminPassword || process.env.ADMIN_PASSWORD || '';
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
app.post('/api/admin/login', (req, res) => {
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
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New password and confirmation do not match' });
  }
  const data = loadData();
  data.settings.adminPassword = newPassword;
  saveData(data);
  // Invalidate all existing sessions so re-login is required
  sessions.clear();
  res.json({ success: true, message: 'Password updated. Please log in again.' });
});

// ============================================================
// PUBLIC ROUTES
// ============================================================
app.get('/api/tournaments', (req, res) => {
  const data = loadData();
  const visible = data.tournaments.filter(t => t.status === 'active' || t.status === 'upcoming');
  res.json(visible);
});

app.get('/api/ticket/:ticketId', (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId.toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
  res.json({
    ...reg,
    qrCode: reg.qrCode, // return real QR data URL
    tournament: tournament
      ? { name: tournament.name, date: tournament.date, twitchLink: tournament.twitchLink, entryFee: tournament.entryFee, game: tournament.game }
      : null
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const { playerName, gamertag, phone, location, tournamentId } = req.body;

    if (!playerName || !gamertag || !phone || !location || !tournamentId) {
      return res.status(400).json({ error: 'All fields are required' });
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
      (r.gamertag.toLowerCase() === gamertag.toLowerCase() || r.phone === phone)
    );
    if (duplicate) {
      return res.status(400).json({ error: 'A player with this gamer tag or phone number is already registered for this tournament' });
    }

    const ticketId = uuidv4().slice(0, 8).toUpperCase();

    const host = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : `http://localhost:${process.env.PORT || 5000}`;

    const ticketUrl = `${host}/ticket/${ticketId}`;
    const qrCode = await QRCode.toDataURL(ticketUrl, { width: 300, margin: 2 });

    const registration = {
      id: uuidv4(),
      ticketId,
      playerName,
      gamertag,
      phone,
      location,
      tournamentId: parseInt(tournamentId),
      paymentStatus: 'pending',
      paymentReference: null,
      referenceSubmittedAt: null,
      checkedIn: false,
      checkedInAt: null,
      approvedAt: null,
      rejectedAt: null,
      registeredAt: new Date().toISOString(),
      qrCode
    };

    data.registrations.push(registration);
    tournament.registrations.push(registration.id);
    saveData(data);

    // ── PAYMENT PROVIDER HOOK ──────────────────────────────────────────
    // PAYMENT_PROVIDER env var controls payment flow:
    //   'manual'   (default) → bank transfer, admin approves manually
    //   'paystack' (future)  → auto-initiates Paystack inline popup
    //
    // To integrate Paystack later:
    //   1. Set PAYMENT_PROVIDER=paystack and PAYSTACK_SECRET_KEY in env/secrets
    //   2. Call Paystack initialize API here and return authorization_url
    //   3. Add POST /api/paystack/webhook to auto-confirm on successful charge
    //   4. Frontend reads paymentProvider from response to show correct UI
    // ─────────────────────────────────────────────────────────────────
    const paymentProvider = process.env.PAYMENT_PROVIDER || 'manual';

    res.json({
      success: true,
      message: 'Registration successful! Follow the payment instructions to secure your spot.',
      ticketId,
      qrCode,
      paymentProvider,
      paymentInfo: {
        // Manual bank transfer details — update these with your real account
        amount: tournament.entryFee,
        bankName: process.env.BANK_NAME || 'Access Bank',
        accountName: process.env.ACCOUNT_NAME || 'East Arena Gaming',
        accountNumber: process.env.ACCOUNT_NUMBER || '0123456789',
        reference: ticketId
        // Paystack fields will go here when PAYMENT_PROVIDER=paystack:
        // paystackAuthUrl: <from Paystack API>,
        // paystackRef: <generated ref>,
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
  res.json({ success: true, message: 'Payment reference submitted. An admin will confirm shortly.' });
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
    return sum + (t ? t.entryFee : 0);
  }, 0);

  res.json({
    total: regs.length,
    confirmed: confirmed.length,
    pending: pending.length,
    rejected: rejected.length,
    checkedIn: regs.filter(r => r.checkedIn).length,
    revenue,
    tournaments: data.tournaments.length
  });
});

app.get('/api/admin/registrations', requireAdmin, (req, res) => {
  const data = loadData();
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status || '';

  let regs = data.registrations.map(r => {
    const t = data.tournaments.find(t => t.id === r.tournamentId);
    return { ...r, qrCode: undefined, tournamentName: t ? t.name : 'Unknown', game: t?.game || '' };
  });

  if (status) regs = regs.filter(r => r.paymentStatus === status);
  if (search) {
    regs = regs.filter(r =>
      r.playerName.toLowerCase().includes(search) ||
      r.gamertag.toLowerCase().includes(search) ||
      r.ticketId.toLowerCase().includes(search) ||
      r.phone.includes(search) ||
      (r.paymentReference || '').toLowerCase().includes(search)
    );
  }

  regs.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
  res.json(regs);
});

app.post('/api/admin/approve/:ticketId', requireAdmin, (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  reg.paymentStatus = 'confirmed';
  reg.approvedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/reject/:ticketId', requireAdmin, (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  reg.paymentStatus = 'rejected';
  reg.rejectedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/checkin/:ticketId', requireAdmin, (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  if (reg.paymentStatus !== 'confirmed') {
    return res.status(400).json({ error: 'Cannot check in — payment not yet confirmed' });
  }
  reg.checkedIn = true;
  reg.checkedInAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
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
  res.setHeader('Content-Disposition', `attachment; filename=east-arena-backup-${timestamp}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

// Tournament management
app.get('/api/admin/tournaments', requireAdmin, (req, res) => {
  const data = loadData();
  res.json(data.tournaments);
});

app.post('/api/admin/tournaments', requireAdmin, (req, res) => {
  const { name, game, date, entryFee, prizePoolFirst, prizePoolSecond, prizePoolThird, maxPlayers, twitchLink, status } = req.body;
  if (!name || !date || !entryFee) {
    return res.status(400).json({ error: 'Name, date, and entry fee are required' });
  }
  const data = loadData();
  const newId = data.tournaments.length > 0 ? Math.max(...data.tournaments.map(t => t.id)) + 1 : 1;
  const tournament = {
    id: newId,
    name,
    game: game || 'FIFA',
    date,
    entryFee: parseInt(entryFee),
    prizePool: {
      first:  parseInt(prizePoolFirst)  || 0,
      second: parseInt(prizePoolSecond) || 0,
      third:  parseInt(prizePoolThird)  || 0
    },
    status: status || 'active',
    twitchLink: twitchLink || '',
    maxPlayers: parseInt(maxPlayers) || 16,
    registrations: []
  };
  data.tournaments.push(tournament);
  saveData(data);
  res.json({ success: true, tournament });
});

app.put('/api/admin/tournaments/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const t = data.tournaments.find(t => t.id === parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const { name, game, date, entryFee, prizePoolFirst, prizePoolSecond, prizePoolThird, maxPlayers, twitchLink, status } = req.body;
  if (name !== undefined)           t.name       = name;
  if (game !== undefined)           t.game       = game;
  if (date !== undefined)           t.date       = date;
  if (entryFee !== undefined)       t.entryFee   = parseInt(entryFee);
  if (prizePoolFirst !== undefined)  t.prizePool.first  = parseInt(prizePoolFirst)  || 0;
  if (prizePoolSecond !== undefined) t.prizePool.second = parseInt(prizePoolSecond) || 0;
  if (prizePoolThird !== undefined)  t.prizePool.third  = parseInt(prizePoolThird)  || 0;
  if (maxPlayers !== undefined)     t.maxPlayers = parseInt(maxPlayers);
  if (twitchLink !== undefined)     t.twitchLink = twitchLink;
  if (status !== undefined)         t.status     = status;
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

// ============================================================
// PAGE ROUTES
// ============================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/ticket/:ticketId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ticket.html'));
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ East Arena Gaming Tournament — http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
});
