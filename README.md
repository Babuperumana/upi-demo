# UPI Demo — Coolify Deployment

A fully functional UPI payment demo app built with `@babuperumana/upipg-new`, ready to deploy on Coolify via Docker.

## What it does

- Accept UPI payments via BharatPe merchant account
- Auto-verifies payments within 5-10 seconds
- Captures payer VPA, name, and UPI app used
- Mobile-friendly payment pages with QR codes
- SSE live updates — no page reloads
- SQLite persistence — no external database needed

## Quick Deploy to Coolify

1. Push this repo to GitHub
2. In Coolify: **Applications → New → Deploy from Git**
3. Select your GitHub repo
4. Set the Dockerfile as build pack (or let Coolify auto-detect)
5. Add environment variables (see below)
6. Deploy

### Required Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `/app/data/upi-demo.db` | SQLite DB path |

### Optional: BharatPe Credentials

Set these after first deploy via the `/setup` page:

```env
BHARATPE_UPI_ID=merchant@okaxis
BHARATPE_MERCHANT_ID=49354135
BHARATPE_API_TOKEN=your-token
BHARATPE_API_COOKIE=your-cookie
```

## Local Development

```bash
npm install
cp .env.example .env
node src/server.js
```

Open http://localhost:3000 — first visit will prompt you to configure a merchant.

## Test Flow

1. Visit `/setup` — enter your BharatPe credentials
2. Visit `/pay/demo` — enter an amount
3. Scan the QR code or open the UPI link with any UPI app
4. Payment page auto-updates when payment is detected
5. View events at `/events/:orderId`

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/setup` | Interactive merchant setup |
| GET | `/` | Dashboard |
| GET | `/merchants` | List merchants |
| POST | `/merchants` | Create merchant |
| POST | `/payments` | Create payment |
| GET | `/payments` | List payments |
| GET | `/payments/:orderId` | Payment details |
| GET | `/pay/:orderId` | Payment status page |
| GET | `/qr/:orderId` | QR code PNG |
| GET | `/pay/demo` | New payment form |
| GET | `/events/stream` | SSE live events |

## Tech Stack

- `@babuperumana/upipg-new` — BharatPe payment verification
- `express` — REST API
- `better-sqlite3` — Local persistence
- `qrcode` — QR generation
- Docker — Coolify deployment

## License

MIT
