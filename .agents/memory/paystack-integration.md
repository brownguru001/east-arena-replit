---
  name: Paystack Integration
  description: How Paystack payment is implemented in East Arena Gaming
  ---

  ## Flow (redirect, not inline)
  1. User registers → pending ticket created
  2. Frontend calls POST /api/payment/initialize (ticketId in body)
  3. Server calls Paystack API with PAYSTACK_SECRET_KEY (never in frontend)
  4. Returns authorization_url to frontend
  5. Frontend redirects: window.location.href = authorization_url
  6. User pays on Paystack's hosted page
  7. Paystack redirects to GET /payment/callback?reference=TICKETID
  8. Server verifies with Paystack API → confirms ticket → sends email
  9. Webhook POST /api/webhooks/paystack fires independently as backup

  ## Security
  - PAYSTACK_SECRET_KEY: server-side secret only, never in any frontend file
  - Webhook verified via HMAC-SHA512 of raw body (express.raw before express.json)
  - Paystack reference = ticketId (8 char uppercase UUID slice)

  ## Fallback
  - If PAYSTACK_SECRET_KEY not set: Paystack button hidden, manual bank transfer shown
  - Manual transfer: user submits reference → admin approves via /api/admin/approve/:ticketId

  ## Webhook URL to register in Paystack dashboard
  https://eastarenagaming.com.ng/api/webhooks/paystack

  **Why redirect not inline:** No public key needed in frontend, simpler, more secure.
  