# Sandboxed

Sandboxed is an isolated movie and series interface with device-specific playback guidance and an optional paid membership layer.

## Membership

- Email/password accounts with verified email through Supabase Auth
- Three-day no-card trial beginning on first playback
- Four registered devices, two simultaneous streams, and two device replacements per 30 days
- $20 yearly Stripe subscription
- $20 NOWPayments cryptocurrency purchase granting 365 days
- Server-side entitlement checks, hashed device/IP abuse signals, restricted database tables, and verified payment callbacks

Membership remains disabled until all required Supabase variables and `DEVICE_HASH_SECRET` are present. This keeps an incomplete configuration from breaking playback.

## Run locally

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Deploy

Deploy the folder root to Vercel with no build command. Set `TMDB_READ_TOKEN` (recommended) or `TMDB_API_KEY` for current metadata.

1. Run `supabase-setup.sql` once in the Supabase SQL editor.
2. Copy `.env.example` keys into Vercel Production environment variables. Never commit the values.
3. In Supabase Auth URL Configuration, set the Site URL to `https://sandboxed-tv.vercel.app` and add the same URL to Redirect URLs.
4. In Stripe, send events to `https://sandboxed-tv.vercel.app/api/stripe-webhook` and store the signing secret as `STRIPE_WEBHOOK_SECRET`.
5. In NOWPayments, store the API and IPN secrets in Vercel. The app supplies its callback URL when it creates an invoice.

Required membership variables are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `DEVICE_HASH_SECRET`. Stripe and NOWPayments activate independently when their respective variables are present.

## Playback

Movies use `https://player.videasy.to/movie/{tmdbId}`. Series use `https://player.videasy.to/tv/{tmdbId}/{season}/{episode}` with Videasy's episode selector and next-episode options enabled. The iframe is not sandboxed because Videasy blocks restricted embeds.
