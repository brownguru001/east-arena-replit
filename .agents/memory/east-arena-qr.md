---
  name: East Arena QR Code Strategy
  description: QR codes generated on-demand, not stored in JSON
  ---

  ## Approach
  QR codes are generated fresh on each /api/ticket/:id request.
  They are NOT stored in data.json (removed to prevent file bloat).
  QR content = /ticket/:ticketId URL using APP_URL env or REPLIT_DEV_DOMAIN.

  ## Email attachment
  When sending emails, QR is generated fresh in memory as a Buffer and attached as CID image.

  **Why:** Storing base64 QR in JSON caused significant file size bloat with many registrations.
  