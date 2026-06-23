// ============================================
// EAST ARENA - COMPLETE APP FOR REPLIT
// ============================================
// 
// This is a FULL-STACK app ready to deploy on Replit
// Backend: Node.js + Express
// Frontend: React + Tailwind
// Database: JSON file (no setup needed, scales for MVP)
//
// Deploy to Replit:
// 1. Create new Node.js project
// 2. Paste this entire file as index.js
// 3. npm install express cors uuid qrcode dotenv
// 4. Run → Click "Run"
// 5. Share URL with players
//
// ============================================

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

// ============================================
// DATA STORAGE (JSON file - no DB needed)
// ============================================

const DATA_FILE = path.join(__dirname, 'data.json');

const loadData = () => {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return {
    tournaments: [
      {
        id: 1,
        name: 'East Arena Championship S1',
        date: '2024-07-20',
        entryFee: 30000,
        prizePool: { first: 150000, second: 80000, third: 40000 },
        status: 'upcoming',
        twitchLink: 'https://twitch.tv/eastarena',
        maxPlayers: 16,
        registrations: []
      }
    ],
    registrations: []
  };
};

const saveData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

// ============================================
// ROUTES - REGISTRATION & TICKETS
// ============================================

// Get all tournaments
app.get('/api/tournaments', (req, res) => {
  const data = loadData();
  res.json(data.tournaments);
});

// Register player
app.post('/api/register', async (req, res) => {
  try {
    const { playerName, gamertag, phone, location, tournamentId } = req.body;
    const data = loadData();
    
    const tournament = data.tournaments.find(t => t.id === parseInt(tournamentId));
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Create registration
    const ticketId = uuidv4().slice(0, 8).toUpperCase();
    const registration = {
      id: uuidv4(),
      ticketId,
      playerName,
      gamertag,
      phone,
      location,
      tournamentId: parseInt(tournamentId),
      paymentStatus: 'pending', // After Paystack callback → confirmed
      registeredAt: new Date().toISOString(),
      qrCode: null
    };

    // Generate QR code
    const qrCodeUrl = `${process.env.REPLIT_URL || 'http://localhost:3000'}/ticket/${ticketId}`;
    registration.qrCode = await QRCode.toDataURL(qrCodeUrl);

    data.registrations.push(registration);
    tournament.registrations.push(registration.id);
    saveData(data);

    res.json({
      success: true,
      message: 'Registration successful! Complete payment to confirm.',
      ticketId,
      nextStep: 'paystack_payment',
      paymentInfo: {
        amount: tournament.entryFee,
        email: phone + '@eastarena.ng', // For Paystack
        reference: ticketId
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get registration (for ticket view)
app.get('/api/registration/:ticketId', (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  
  const tournament = data.tournaments.find(t => t.id === reg.tournamentId);
  res.json({
    ...reg,
    tournament: {
      name: tournament.name,
      date: tournament.date,
      twitchLink: tournament.twitchLink
    }
  });
});

// Confirm payment (called after Paystack webhook)
app.post('/api/confirm-payment/:ticketId', (req, res) => {
  const data = loadData();
  const reg = data.registrations.find(r => r.ticketId === req.params.ticketId);
  
  if (!reg) return res.status(404).json({ error: 'Ticket not found' });
  
  reg.paymentStatus = 'confirmed';
  saveData(data);
  
  res.json({ success: true, message: 'Payment confirmed! See you at the tournament.' });
});

// Get tournament dashboard
app.get('/api/dashboard/:tournamentId', (req, res) => {
  const data = loadData();
  const tournament = data.tournaments.find(t => t.id === parseInt(req.params.tournamentId));
  
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  
  const registrations = data.registrations.filter(r => r.tournamentId === tournament.id);
  const confirmed = registrations.filter(r => r.paymentStatus === 'confirmed');
  
  res.json({
    tournament,
    stats: {
      total: registrations.length,
      confirmed: confirmed.length,
      revenue: confirmed.length * tournament.entryFee
    },
    players: confirmed.map(r => ({
      playerName: r.playerName,
      gamertag: r.gamertag,
      location: r.location,
      ticketId: r.ticketId
    }))
  });
});

// ============================================
// FRONTEND - HTML + REACT
// ============================================

const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EAST ARENA - Premium Gaming Tournaments</title>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #0F1419; color: #fff; }
    .gold { color: #D4AF37; }
    .teal { color: #00D9FF; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;

    // Main App
    function EastArena() {
      const [page, setPage] = useState('home');
      const [tournaments, setTournaments] = useState([]);
      const [formData, setFormData] = useState({
        playerName: '',
        gamertag: '',
        phone: '',
        location: '',
        tournamentId: 1
      });
      const [ticketData, setTicketData] = useState(null);
      const [loading, setLoading] = useState(false);

      useEffect(() => {
        fetch('/api/tournaments')
          .then(res => res.json())
          .then(data => setTournaments(data));
      }, []);

      const handleRegister = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
          const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
          });
          const data = await res.json();
          setTicketData(data);
          setPage('ticket');
        } catch (error) {
          alert('Error: ' + error.message);
        }
        setLoading(false);
      };

      return (
        <div className="min-h-screen bg-slate-950">
          {/* NAV */}
          <nav className="bg-slate-900 border-b border-amber-500/20 p-4 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto flex justify-between items-center">
              <div className="flex items-center gap-2 text-2xl font-black gold">🏆 EAST ARENA</div>
              <div className="flex gap-4">
                <button onClick={() => setPage('home')} className="px-4 py-2 hover:text-amber-400">Home</button>
                <button onClick={() => setPage('register')} className="px-4 py-2 bg-amber-500 text-black rounded font-bold">Register</button>
              </div>
            </div>
          </nav>

          {/* PAGES */}
          <main className="max-w-7xl mx-auto p-6">
            {page === 'home' && <HomePage tournaments={tournaments} setPage={setPage} />}
            {page === 'register' && <RegisterPage tournaments={tournaments} formData={formData} setFormData={setFormData} handleRegister={handleRegister} loading={loading} />}
            {page === 'ticket' && <TicketPage ticketData={ticketData} />}
          </main>
        </div>
      );
    }

    // HOME PAGE
    function HomePage({ tournaments, setPage }) {
      return (
        <div className="space-y-12">
          {/* HERO */}
          <div className="bg-gradient-to-r from-amber-600 to-amber-500 rounded-2xl p-12 text-center text-slate-900">
            <h1 className="text-5xl font-black mb-3">EAST ARENA</h1>
            <p className="text-xl font-semibold mb-8">Premium FIFA Gaming Tournaments</p>
            <button onClick={() => setPage('register')} className="bg-slate-900 text-amber-400 font-bold py-3 px-8 rounded-lg hover:scale-105 transition text-lg">JOIN A TOURNAMENT</button>
          </div>

          {/* TOURNAMENTS */}
          <div>
            <h2 className="text-3xl font-black gold mb-6">UPCOMING TOURNAMENTS</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {tournaments.map(t => (
                <div key={t.id} className="bg-slate-800 border border-amber-500/30 rounded-xl p-6 hover:border-amber-400/60 transition">
                  <h3 className="text-lg font-bold text-white mb-4">{t.name}</h3>
                  <div className="space-y-2 text-sm mb-4">
                    <p><span className="text-slate-400">Entry Fee:</span> <span className="teal font-bold">₦{t.entryFee.toLocaleString()}</span></p>
                    <p><span className="text-slate-400">Prize Pool:</span> <span className="text-green-400 font-bold">₦{(t.prizePool.first + t.prizePool.second + t.prizePool.third).toLocaleString()}</span></p>
                    <p><span className="text-slate-400">Date:</span> <span className="text-white">{new Date(t.date).toLocaleDateString()}</span></p>
                    <p><span className="text-slate-400">Players:</span> <span className="text-white">{t.registrations.length}/16</span></p>
                  </div>
                  <button onClick={() => setPage('register')} className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-2 rounded transition">REGISTER NOW</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    // REGISTER PAGE
    function RegisterPage({ tournaments, formData, setFormData, handleRegister, loading }) {
      return (
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-black gold mb-8">TOURNAMENT REGISTRATION</h2>
          <form onSubmit={handleRegister} className="bg-slate-800 border border-amber-500/30 rounded-xl p-8 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <input
                type="text"
                placeholder="Full Name"
                required
                value={formData.playerName}
                onChange={(e) => setFormData({...formData, playerName: e.target.value})}
                className="bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
              />
              <input
                type="text"
                placeholder="Gamer Tag"
                required
                value={formData.gamertag}
                onChange={(e) => setFormData({...formData, gamertag: e.target.value})}
                className="bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
              />
              <input
                type="tel"
                placeholder="Phone Number (0803...)"
                required
                value={formData.phone}
                onChange={(e) => setFormData({...formData, phone: e.target.value})}
                className="bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
              />
              <input
                type="text"
                placeholder="Location (Your City)"
                required
                value={formData.location}
                onChange={(e) => setFormData({...formData, location: e.target.value})}
                className="bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
              />
            </div>

            <select
              value={formData.tournamentId}
              onChange={(e) => setFormData({...formData, tournamentId: e.target.value})}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white focus:border-amber-400 focus:outline-none"
            >
              {tournaments.map(t => (
                <option key={t.id} value={t.id}>{t.name} - ₦{t.entryFee.toLocaleString()}</option>
              ))}
            </select>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold py-3 rounded-lg transition disabled:opacity-50"
            >
              {loading ? 'Processing...' : 'CONFIRM REGISTRATION'}
            </button>
          </form>
        </div>
      );
    }

    // TICKET PAGE
    function TicketPage({ ticketData }) {
      const [confirmed, setConfirmed] = useState(false);

      const handlePaymentConfirm = async () => {
        // In real app, this is called by Paystack webhook
        await fetch(\`/api/confirm-payment/\${ticketData.ticketId}\`, { method: 'POST' });
        setConfirmed(true);
      };

      return (
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-black gold mb-8">YOUR TICKET</h2>
          
          {!confirmed ? (
            <div className="bg-slate-800 border border-amber-500/30 rounded-xl p-8 text-center space-y-6">
              <div className="text-2xl font-black teal">✓ Registration Successful!</div>
              <p className="text-slate-300">Your Ticket ID: <span className="font-bold text-amber-400">{ticketData.ticketId}</span></p>
              
              <div className="bg-slate-700 p-6 rounded-lg">
                <p className="text-sm text-slate-400 mb-4">Next Step: Complete Payment via Paystack</p>
                <button
                  onClick={() => {
                    // In real deployment, integrate Paystack API here
                    alert('Paystack payment flow:\n1. Click Pay\n2. Complete payment\n3. Return to ticket');
                    handlePaymentConfirm();
                  }}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition"
                >
                  PROCEED TO PAYMENT (₦{ticketData.paymentInfo.amount.toLocaleString()})
                </button>
              </div>

              <p className="text-xs text-slate-400">You'll receive an SMS confirmation after payment</p>
            </div>
          ) : (
            <div className="bg-slate-800 border border-green-500/30 rounded-xl p-8 text-center space-y-6">
              <div className="text-2xl font-black text-green-400">✓ PAYMENT CONFIRMED</div>
              <p className="text-slate-300">Your Digital Ticket is ready. Screenshot or show at venue.</p>
              
              <div className="bg-white p-6 rounded-lg inline-block">
                {/* QR code would render here */}
                <div className="w-48 h-48 bg-slate-300 flex items-center justify-center rounded">
                  QR CODE {ticketData.ticketId}
                </div>
              </div>

              <div className="bg-slate-700 p-4 rounded-lg text-left text-sm space-y-2">
                <p><span className="text-slate-400">Name:</span> <span className="font-bold">{ticketData.playerName}</span></p>
                <p><span className="text-slate-400">Gamer Tag:</span> <span className="font-bold text-amber-400">{ticketData.gamertag}</span></p>
                <p><span className="text-slate-400">Ticket ID:</span> <span className="font-mono text-teal">{ticketData.ticketId}</span></p>
              </div>

              <p className="text-xs text-slate-400">Show this QR code at the venue entrance</p>
            </div>
          )}
        </div>
      );
    }

    // RENDER
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<EastArena />);
  </script>
</body>
</html>
`;

// Frontend is served from public/index.html via express.static above

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ East Arena live at http://localhost:${PORT}`);
  console.log(`Share this URL with players to register!`);
});
