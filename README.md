# Sandboxed

Sandboxed is an isolated movie and series interface with device-specific playback guidance and an optional paid membership layer.

## Membership

- Email/password accounts with verified email through Supabase Auth
- Three-day no-card trial beginning on first playback
- Four registered devices, two simultaneous streams, and two device replacements per 30 days
- $20 yearly Stripe subscription
- $20 NOWPayments cryptocurrency purchase granting 365 days
- Server-side entitlement checks, hashed device/IP abuse signals, restricted database tables, and verified payment callbacks

Playback fails closed until all required Supabase variables and `DEVICE_HASH_SECRET` are present. If membership configuration or its client script is unavailable, the player remains locked instead of falling back to a direct third-party URL.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`. This runs the same standalone Node application used by Namecheap cPanel.

## Deploy

Deploy the folder root to Vercel with no build command. Set `TMDB_READ_TOKEN` (recommended) or `TMDB_API_KEY` for current metadata.

1. Run `supabase-setup.sql` once in the Supabase SQL editor.
2. Copy `.env.example` keys into Vercel Production environment variables. Never commit the values.
3. In Supabase Auth URL Configuration, set the Site URL to `https://sandboxed-tv.vercel.app` and add the same URL to Redirect URLs.
4. In Stripe, send events to `https://sandboxed-tv.vercel.app/api/stripe-webhook` and store the signing secret as `STRIPE_WEBHOOK_SECRET`.
5. In NOWPayments, store the API and IPN secrets in Vercel. The app supplies its callback URL when it creates an invoice.

Required membership variables are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `DEVICE_HASH_SECRET`. Stripe and NOWPayments activate independently when their respective variables are present.

## Namecheap Shared Hosting

The repository also runs as a single cPanel Node application without third-party packages.

1. In cPanel, open **Setup Node.js App** and select Node.js 20 or newer.
2. Set the application root to the uploaded repository folder, production mode, and `server.js` as the startup file.
3. Add the variables from `.env.example` through cPanel; do not upload a populated `.env` file.
4. Start or restart the application and confirm `/healthz` returns `{\"ok\":true}`.
5. Update `SITE_URL`, Supabase redirect URLs, Stripe’s webhook URL, and the domain only after the temporary deployment passes testing.

## Playback

Movies use `https://player.videasy.to/movie/{tmdbId}`. Series use `https://player.videasy.to/tv/{tmdbId}/{season}/{episode}` with Videasy's episode selector and next-episode options enabled. The iframe is not sandboxed because Videasy blocks restricted embeds.
