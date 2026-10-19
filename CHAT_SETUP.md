# WEB STUDIO client chat — deployment notes

## Current state
- The Astro interface is implemented in `src/components/ChatWidget.astro` and mounted by `src/layouts/BaseLayout.astro`.
- The chat opens as a compact panel, can expand into a large in-site workspace, and uses a full-screen layout on narrow mobile screens.
- Client messages are designed to be stored in Cloudflare D1 via the Worker API. The browser stores a random client token and conversation ID so a client can return after closing the browser or rebooting the computer in the same browser profile.
- The Worker API is in `worker/src/index.ts`; schema is `worker/schema.sql`.
- The current contact form is intentionally retained until the backend is deployed and tested. Do not remove it before sending, persistence, email notification, and admin replies have been verified end to end.

## Required setup before the chat is live
1. Create a Cloudflare D1 database and replace the placeholder `database_id` in `worker/wrangler.toml`.
2. Apply `worker/schema.sql` to that database.
3. Deploy the Worker.
4. Set Worker secrets: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `RESEND_API_KEY`, `ADMIN_EMAIL`, and `EMAIL_FROM`. Email notification requires a configured Resend account and verified sender.
5. Set the GitHub Actions build variable `PUBLIC_CHAT_API_URL` to the deployed Worker origin, then update the Pages workflow to expose that variable during build.
6. Build and test the Worker and Astro site. Test client messages, email delivery, reload persistence, mobile expansion, admin login, admin replies, and CORS.
7. Build the protected admin chat UI against `/api/admin/login`, `/api/admin/conversations`, and `/api/admin/messages`.
8. Only after end-to-end verification, replace the contact form with the chat as the primary contact path.

## Reliability and recovery
- D1 is the primary message store; the Worker does not depend on the studio VPS.
- Cloudflare D1's built-in recovery is not a substitute for an independent backup. Before production, add a scheduled export to a separate storage provider and periodically test restoring it.
- Three-digit transfer codes have only 1,000 possible values. They expire after five minutes, are single-use, and attempts are throttled per source IP, but this is not equivalent to a password or a high-entropy recovery secret. Keep the expiry and attempt limits; consider requiring confirmation on the source device if stronger protection is needed.
- The transfer code is not an account recovery mechanism. If the user loses access to all devices and has no active transfer code, the conversation cannot currently be recovered by identity/email.
- No absolute zero-loss guarantee is possible. Verify backup/restore and email-delivery failure handling before promising this to clients.
