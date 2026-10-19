# WEB STUDIO client chat — deployment notes

## Current state
- The Astro interface is implemented in `src/components/ChatWidget.astro` and mounted by `src/layouts/BaseLayout.astro`.
- The chat opens as a compact panel, can expand into a large in-site workspace, and uses a full-screen layout on narrow mobile screens.
- Client messages are designed to be stored in Cloudflare D1 via the Worker API. The browser stores a random client token and conversation ID so a client can return after closing the browser or rebooting the computer in the same browser profile.
- Cross-device transfer is implemented on this feature branch: create a three-digit one-time code, valid for five minutes, then enter it on the second device. A successful transfer adds a second device credential without disconnecting the first.
- The Worker API is in `worker/src/index.ts`; schema is `worker/schema.sql`.
- The current contact form is intentionally retained until the backend is deployed and tested. Do not remove it before sending, persistence, email notification, and admin replies have been verified end to end.

## Required setup before the chat is live
1. Create a Cloudflare D1 database and replace the placeholder `database_id` in `worker/wrangler.toml`.
2. Apply `worker/schema.sql` to that database.
3. Create/deploy the Worker named `web-studio-client-chat` using `worker/wrangler.toml` and `worker/src/index.ts`. Ensure its D1 binding is named `DB` and points to `web-studio-chat`.
4. Set Worker secrets: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `RESEND_API_KEY`, `ADMIN_EMAIL`, and `EMAIL_FROM`. Email notification requires a configured Resend account and verified sender.
5. In the GitHub repository settings, add the Actions repository variable `PUBLIC_CHAT_API_URL` with the deployed Worker origin (for example, `https://web-studio-client-chat.<your-subdomain>.workers.dev`). The Pages workflow now passes this variable to the Astro build. Re-run the workflow after adding/changing it.
6. Build and test the Worker and Astro site. Test client messages, email delivery, reload persistence, mobile expansion, admin login, admin replies, and CORS. The admin page is `/web-studio/admin-chat/` on the GitHub Pages project site.
7. Only after end-to-end verification, replace the contact form with the chat as the primary contact path.
8. Before production, add an independent backup and test restoring it.

## Reliability and recovery
- D1 is the primary message store; the Worker does not depend on the studio VPS.
- Cloudflare D1's built-in recovery is not a substitute for an independent backup. Before production, add a scheduled export to a separate storage provider and periodically test restoring it.
- Three-digit transfer codes have only 1,000 possible values. They expire after five minutes, are single-use, and attempts are throttled per source IP, but this is not equivalent to a password or a high-entropy recovery secret. Keep the expiry and attempt limits; consider requiring confirmation on the source device if stronger protection is needed.
- The transfer code is not an account recovery mechanism. If the user loses access to all devices and has no active transfer code, the conversation cannot currently be recovered by identity/email.
- No absolute zero-loss guarantee is possible. Verify backup/restore and email-delivery failure handling before promising this to clients.
