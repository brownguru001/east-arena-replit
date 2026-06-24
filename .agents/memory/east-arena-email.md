---
  name: East Arena Email Setup
  description: How email notifications work and how to configure SMTP
  ---

  ## Setup
  Uses nodemailer. Configure via env vars:
  - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, EMAIL_FROM

  If not configured, emails are skipped (logged to console). Platform still works fully.

  ## Email types
  1. Registration confirmation — sent on /api/register (with QR attachment)
  2. Payment confirmed — sent on admin approve
  3. Payment rejected — sent on admin reject
  4. Event reminder — sent via admin panel > Settings > Send Reminders
  5. (Templates exist but no auto-send for cancellation — manual via reject)

  **Why:** Graceful skip prevents platform from breaking when SMTP not set up.
  