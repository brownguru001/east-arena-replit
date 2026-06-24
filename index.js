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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'eastarena2024';
const DATA_FILE = path.join(__dirname, 'data.json');

const sessions = new Set();

// ============================================================
// DATA HELPERS
// ============================================================
const defaultData = () => ({
  tournaments: [
    {
      id: 1,
      name: 'East Arena Championship S1',
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
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      return defaultData();
    }
  }
  return defaultData();
};

const saveData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

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
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = uuidv4();
    sessions.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
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

// ============================================================
// PUBLIC ROUTES
// ============================================================

app.get('/api/tournaments', (req, res) => {
  const data = loadData();
  res.json(data.tournaments.filter(t => t.status === 'active' || t.status === 'upcoming'));
});

app.get('/api/ticket/:ticketId', (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId.toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
  res.json({
    ...reg,
    tournament: tournament
      ? { name: tournament.name, date: tournament.date, twitchLink: tournament.twitchLink, entryFee: tournament.entryFee }
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
      return res.status(400).json({ error: 'Tournament is not accepting registrations' });
    }

    const tournamentRegs = data.registrations.filter(
      r => r.tournamentId === parseInt(tournamentId) && r.paymentStatus !== 'rejected'
    );

    if (tournamentRegs.length >= tournament.maxPlayers) {
      return res.status(400).json({ error: `Tournament is full (max ${tournament.maxPlayers} players)` });
    }

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

    res.json({
      success: true,
      message: 'Registration successful! Submit your payment reference to confirm your spot.',
      ticketId,
      qrCode,
      paymentInfo: {
        amount: tournament.entryFee,
        bankName: 'Access Bank',
        accountName: 'East Arena Gaming',
        accountNumber: '0123456789',
        reference: ticketId
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
  reg.paymentReference = paymentReference.trim();
  reg.paymentStatus = 'pending';
  reg.referenceSubmittedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true, message: 'Payment reference submitted. Awaiting admin approval.' });
});

// ============================================================
// ADMIN ROUTES (all protected)
// ============================================================

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const data = loadData();
  const regs = data.registrations;
  const confirmed = regs.filter(r => r.paymentStatus === 'confirmed');
  const pending = regs.filter(r => r.paymentStatus === 'pending');
  const rejected = regs.filter(r => r.paymentStatus === 'rejected');

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
    return { ...r, tournamentName: t ? t.name : 'Unknown' };
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
    return res.status(400).json({ error: 'Cannot check in — payment not confirmed' });
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

app.get('/api/admin/tournaments', requireAdmin, (req, res) => {
  const data = loadData();
  res.json(data.tournaments);
});

app.post('/api/admin/tournaments', requireAdmin, (req, res) => {
  const { name, date, entryFee, prizePoolFirst, prizePoolSecond, prizePoolThird, maxPlayers, twitchLink, status } = req.body;
  if (!name || !date || !entryFee) {
    return res.status(400).json({ error: 'Name, date, and entry fee are required' });
  }
  const data = loadData();
  const newId = data.tournaments.length > 0 ? Math.max(...data.tournaments.map(t => t.id)) + 1 : 1;
  const tournament = {
    id: newId,
    name,
    date,
    entryFee: parseInt(entryFee),
    prizePool: {
      first: parseInt(prizePoolFirst) || 0,
      second: parseInt(prizePoolSecond) || 0,
      third: parseInt(prizePoolThird) || 0
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
  const { name, date, entryFee, prizePoolFirst, prizePoolSecond, prizePoolThird, maxPlayers, twitchLink, status } = req.body;
  if (name !== undefined) t.name = name;
  if (date !== undefined) t.date = date;
  if (entryFee !== undefined) t.entryFee = parseInt(entryFee);
  if (prizePoolFirst !== undefined) t.prizePool.first = parseInt(prizePoolFirst) || 0;
  if (prizePoolSecond !== undefined) t.prizePool.second = parseInt(prizePoolSecond) || 0;
  if (prizePoolThird !== undefined) t.prizePool.third = parseInt(prizePoolThird) || 0;
  if (maxPlayers !== undefined) t.maxPlayers = parseInt(maxPlayers);
  if (twitchLink !== undefined) t.twitchLink = twitchLink;
  if (status !== undefined) t.status = status;
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
  console.log(`✓ East Arena running at http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  Admin login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
});
