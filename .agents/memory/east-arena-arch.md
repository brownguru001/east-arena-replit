---
  name: East Arena Architecture
  description: Tech stack and file layout for East Arena Gaming Tournament platform
  ---

  ## Stack
  - Node.js + Express (index.js)
  - Vanilla HTML/JS frontend with React via CDN (public/)
  - Tailwind CSS via CDN
  - JSON file database (data.json)
  - nodemailer for email
  - helmet + express-rate-limit for security

  ## Key files
  - index.js — all backend routes
  - data.json — database (tournaments + registrations + settings + announcements)
  - public/index.html — main landing + registration SPA (React CDN)
  - public/admin.html — admin panel (vanilla JS)
  - public/ticket.html — individual ticket view
  - public/dashboard.html — player self-service dashboard
  - public/404.html — error page

  ## Route structure
  - / → public SPA (home, register, payment, ticket lookup)
  - /admin → admin panel (requires login)
  - /ticket/:id → ticket view
  - /dashboard → player dashboard (lookup by email or ticket ID)
  - /api/tournaments — public
  - /api/ticket/:id — public, QR generated on-demand
  - /api/register — rate-limited
  - /api/lookup — POST by email or ticketId
  - /api/admin/* — all require Bearer token

  **Why:** Kept simple JSON DB for MVP — no external DB needed, all data in one file.
  