# Sandboxed

Sandboxed is an isolated movie and series interface with device-specific playback guidance and an optional paid membership layer.

## Membership

- Email/password accounts with verified email, matching-password confirmation, password-manager support, and recovery through Supabase Auth
- One three-day no-card trial beginning on first playback
- Repeat-trial protection using hashed device, browser-fingerprint, and network signals; blocked trials receive a clear payment-required message
- Four registered devices, two simultaneous streams, and two device replacements per rolling 30 days
- $30 USD yearly Stripe subscription with Checkout, verified webhooks, customer billing portal, and access through the paid period after cancellation
- $30 USD NOWPayments cryptocurrency purchase granting 365 days, with verified IPN callbacks
- Server-side playback authorization, stale-session cleanup, distinct-device stream counting, and fail-closed access checks
- Long account identifiers wrap safely on desktop and mobile

Playback fails closed until all required Supabase variables and `DEVICE_HASH_SECRET` are present. If membership configuration or its client script is unavailable, the player remains locked instead of falling back to a direct third-party URL.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`. This runs the same standalone Node application used by Namecheap cPanel.

## Vercel deployment

Deploy the folder root to Vercel with no build command. Set `TMDB_READ_TOKEN` (recommended) or `TMDB_API_KEY` for current metadata.

1. Run `supabase-setup.sql` once in the Supabase SQL editor.
2. Copy `.env.example` keys into Vercel Production environment variables. Never commit the values.
3. In Supabase Auth URL Configuration, set the Site URL to `https://sandboxed-tv.vercel.app` and add the same URL to Redirect URLs.
4. In Stripe, send events to `https://sandboxed-tv.vercel.app/api/stripe-webhook` and store the signing secret as `STRIPE_WEBHOOK_SECRET`.
5. In NOWPayments, store the API and IPN secrets in Vercel. The app supplies its callback URL when it creates an invoice.

Required membership variables are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `DEVICE_HASH_SECRET`. Stripe and NOWPayments activate independently when their respective variables are present.

## Namecheap shared hosting

The repository also runs as a single cPanel Node application without third-party packages.

1. In cPanel, open **Setup Node.js App** and select Node.js 20 or newer.
2. Set the application root to `/home/dropdebs/sandboxed`, production mode, and `cpanel.js` as the startup file.
3. Add the variables from `.env.example` through cPanel; do not upload a populated `.env` file.
4. Set `SITE_URL=https://sandboxed.lol`. Configure Supabase redirects for that domain and send Stripe webhooks to `https://sandboxed.lol/api/stripe-webhook`.
5. Start or restart the application and confirm `https://sandboxed.lol/healthz` returns `{\"ok\":true}`.

The standalone server redirects `www.sandboxed.lol` to the apex domain and includes the security, cache-control, request-size, and API routing behavior required by cPanel/LiteSpeed. Payment POST requests intentionally send an empty JSON body so LiteSpeed forwards them to the Node application.

For packaged updates, upload the provided ZIP while already inside `/home/dropdebs/sandboxed`, extract it to that same directory, allow overwrites, and restart the Node application. Do not extract into `/home/dropdebs` or `public_html`. Do not replace the configured environment variables.

## Playback

Movies use `https://player.videasy.to/movie/{tmdbId}`. Series use `https://player.videasy.to/tv/{tmdbId}/{season}/{episode}` with Videasy's episode selector and next-episode options enabled. The iframe is not sandboxed because Videasy blocks restricted embeds.
