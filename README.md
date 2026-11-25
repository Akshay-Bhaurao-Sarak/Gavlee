# Gavlee
![Logo for brand](public/readmemd.png)

🥛 **Gavlee is my ambitious brainchild and one of my major projects**, built with passion, creativity, and a vision to bring an idea to life. This repository will evolve with daily updates, improvements, and new ideas as I work towards making that vision a reality. 🚀

## Authentication and Brevo email verification

Users and 30-day login sessions are stored in the configured MongoDB database (`MONGODB_URI`, or `mongodb://127.0.0.1:27017/gavlee` by default). Passwords are stored as salted scrypt hashes. Registration codes are sent to Brevo's SMTP relay over TLS using Nodemailer. OTPs are not written to logs or MongoDB; only a hash is held in memory until verification or expiry, so a server restart invalidates an unfinished code.

Copy `.env.example` to `.env`. In Brevo, open **Settings → SMTP & API → SMTP**, create an SMTP key, and set `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, and `BREVO_FROM_EMAIL` in `.env`. Use the SMTP key, not the Brevo API key or account password. The sender address must be verified in Brevo. The app uses `smtp-relay.brevo.com` with STARTTLS on port 587. The `.env` file is gitignored; do not commit it or share the SMTP key. Run the app with `npm run dev` or `npm start` to load `.env`.

In local development, the app uses a local development user and sends `/` and `/login` to the listings page without requiring credentials. Authentication remains enabled when `NODE_ENV=production`.
