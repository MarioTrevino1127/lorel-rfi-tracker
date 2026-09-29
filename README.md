# Bid-Phase RFI Tracker

A small internal tool for tracking RFIs during a bid: GCs submit questions anonymously into a
shared, numbered log; consultants draft answers; the owner approves answers before they appear
in the shared log. GC identity is visible only to the owner.

## Requirements
- Node.js 18 or newer
- A MySQL (or MariaDB) database — this app stores everything there, including file attachments.
  It does **not** use local disk for anything persistent, because some hosting platforms
  (including the one this was built for) wipe local files on every restart.

## Environment variables
Set these before the first run (create a `.env` file, or set them in your host's dashboard):

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — your MySQL connection details.
  If your host auto-injects these (GoDaddy's hosted database does), you don't need to set them
  yourself — just make sure the database is attached to the app.
- `OWNER_USERNAME` — username for the first owner login (default: `owner`)
- `OWNER_PASSWORD` — password for the first owner login (default: `changeme123` — change this!)
- `OWNER_EMAIL` — optional; the owner's notification email. Can also be set later from the "Account settings" page after logging in.
- `SESSION_SECRET` — any long random string, used to secure login sessions
- `PORT` — port to run on (most hosts set this automatically; defaults to 3000)
- `RESEND_API_KEY` — optional; enables email notifications via Resend. Without it, the app runs fine but skips sending emails (logs a note instead).
- `RESEND_FROM_EMAIL` — optional; the "from" address for notification emails (default: Resend's shared test address, which can only deliver to the email you signed up to Resend with, until you verify your own domain).

The database schema (tables) and the first owner account are created automatically the first
time the app starts against an empty database. After that, sign in as the owner and create GC
and consultant logins from the "Manage users" tab — each gets a random password shown once on
screen, which you hand off to them directly. Consultants need an email on file to receive
assignment notifications.

## File attachments
GCs and consultants can attach a PDF, JPG, or PNG (3MB max) to a question or answer. Uploaded
images automatically have identifying metadata (camera, location, etc.) stripped before being
stored; PDFs have their standard metadata fields (author, title, producer) cleared as a
best-effort pass. Files are stored directly in the database as BLOBs — not on local disk — so
they survive restarts and redeploys the same way the rest of the data does. Every dependency this
app uses is pure JavaScript (no native/compiled modules), specifically so simplified hosting
platforms that don't support a native build step can still run it without issue.

One thing worth knowing: MySQL has a server-side `max_allowed_packet` setting that caps how large
a single stored value can be. Most managed MySQL hosts default this to 4MB or higher, which
comfortably covers the 3MB attachment limit — but if uploads start failing in production with a
"packet too large"-style error, this setting is the first thing to check with your host.

## Running locally
```
npm install
npm start
```
Then open http://localhost:3000

## Deploying
This is a completely standard Node.js/Express app — it will run on any host that can run
`npm install && npm start`, keep a process alive, and provide a MySQL database (a VPS with MySQL
installed, Railway, Render, or a Node-app hosting product like GoDaddy's with a hosted database
attached). Just set the environment variables above in whatever dashboard your host provides —
or, if the host auto-injects database credentials, just attach the database and leave those be.

