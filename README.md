# Showup

Show up for your workouts, or pay up.

Showup is a small web app for one person. You pick the days you train and prove each
session with a photo of the workout summary, which Claude reads. If a session is missing
when the day is over, you owe a friend real money, and every miss in a row costs more. By
default the app tells your friend what to collect from you; bunq can also send it
automatically. The friend keeps it for a while and then gives most of it back.

It is open source (MIT). Each person runs their own copy: there is no shared service to sign
up for.

## Status

Showup is new and not in daily use yet. Covered by automated tests: the rules, the nightly
judging, penalties, sick days, the friend-collects flow, the photo rules (with a stand-in
for Claude) and the bunq payment logic (against a fake bank and, with `npm run check:bunq`,
bunq's sandbox). **Not tried for real yet:**

- a notification actually arriving on a real phone, and installing the friend's page on an
  iPhone Home Screen
- a real workout screenshot going through the Claude photo check (only drawn test images so far)
- the photo upload button in a browser with a real key
- connecting Strava
- sending money with a real (non-sandbox) bunq account
- a full deployment on Vercel with a Postgres database

If you try one of these, please open an issue with what happened.

## Features

- Fixed training days with a minimum per session (distance for runs, time for strength)
- Photo proof checked by Claude, with the pass/fail decision made by the app's own rules
- Escalating penalties with a per-miss and per-week cap, all adjustable
- "Friend collects" by default: the friend gets their own installable page and push
  notifications, no account needed; optional automatic bank transfers through bunq
- Sick days, a practice mode before real money, and a 7-day delay on rule changes once armed
- Optional Strava connection so a recorded run counts without a photo
- Runs on your own computer with no setup (an embedded Postgres), or on Vercel with Postgres

## How it works

**Training days.** The default week is run on Monday, Wednesday and Saturday, strength on
Tuesday and Friday. Only those days count, and each one has its own deadline: midnight.

**Proof.** Every session is proven with a photo: a screenshot of the workout's summary
(Apple Fitness, the watch, Strava, Garmin, anything that shows the figures), uploaded on the
day itself or until 03:00 the next morning. Claude reads it, and the app's own rules decide:

- it shows the right kind of workout (a run on run days, a strength workout on strength days)
- the date on it is the training day (screens that say "Today" are read against the upload time)
- a run is at least 3.5 km, a strength workout at least 20 minutes
- it is not the same workout as an earlier photo: Claude compares it with the six most
  recent photos of the same kind, and the app refuses any photo whose distance and time
  match an earlier one exactly, so an old screenshot with the date edited doesn't pass either

A photo that fails is not kept, and the reason is shown right away, so there is time to send
a better one. Connecting Strava (optional) lets a recorded run of 3.5 km count without a photo.

**Judging.** Each day is judged at 03:00 the next morning.

**The price.**

| Miss in a row | Cost |
| --- | --- |
| 1st | €10 |
| 2nd | €20 |
| 3rd | €40 |
| 4th and later | €80 (the most for one miss) |

A week (Monday to Sunday) never costs more than €150. A completed session sets the count
back to one. All of these numbers can be changed in Settings.

**Sick days.** Three training days per calendar month can be marked as sick. A sick day
costs nothing and leaves the count of misses in a row where it was, as if the day had not
been planned. It is used on the day itself (until 03:00 the next morning), and it comes
back if you train anyway. Your friend can see how many you have used.

**The money.** Your friend gets their own version of the app: a private link they can add
to their Home Screen. By default no bank is involved:

1. You miss a day. When it is judged the next night (the nightly check runs at 02:30 UTC,
   so 03:30 in winter and 04:30 in summer, Amsterdam time) your friend's phone gets a
   notification: what was skipped and how much to collect from you.
2. You pay them (cash, a transfer, a payment request), and they tap "I've got it".
3. They hold it for 14 days. Then they get another notification, give back 90% and keep
   10% for themselves. They tap "I've given it back".

Your Today screen shows what you still owe until your friend marks it collected. The share
your friend keeps (10%) and the hold time are rules like the others, so they can't be
changed on a whim once real money is on.

If you'd rather not depend on your friend chasing you, bunq can send every penalty by
itself (Rules, How the money moves; needs bunq Pro or Elite). Each penalty is then its own
transfer with a reference like `SHOWUP-20261123`, and money your friend sends back with
"showup" in the description is matched by itself. The friend keeps their share either way.

**Practice first.** Nothing is charged until you switch on real money in Settings. Until
then every day is tracked and you see what it would have cost.

**No quick way out.** Once real money is on, any change to the rules (including switching
it off, or changing the friend) only starts 7 days later.

## Try it without connecting anything

```bash
npm install
npm run demo
```

This fills a separate demo database with five weeks of made-up history and opens the app
on http://localhost:3210. The password is printed in the terminal. No bank is connected in
the demo, so nothing can move money. `DEMO_TODAY=run npm run demo` (or `strength`, `done`,
`rest`) picks what today looks like.

## Use it for real

1. Put the app online (see below), so your friend's phone can reach it, and choose a password.
2. **Settings, Rules:** enter your friend's full name.
3. **Settings, Photo check:** paste a Claude API key (console.anthropic.com, API keys, with
   some credit under Billing). Each check costs a few cents.
4. **Settings, friend's page:** enter your name (and, if you like, your IBAN for the money
   coming back), then send your friend their link. On their phone they open it, add it to the
   Home Screen (on an iPhone: Share, Add to Home Screen), open it from there and tap
   "Turn on notifications". Settings shows when that worked.
5. Train in practice mode for a few days, then switch on real money. It starts the next day.

Only if bunq sends the money (Rules, How the money moves): add the friend's IBAN and paste a
bunq API key in Settings, Bank.
- API keys need bunq Pro or Elite.
- In the bunq app: Profile, Security & Settings, Developers, API keys.
- Before pasting it anywhere, open the key's menu and switch on "Allow all IP addresses",
  otherwise bunq refuses a server whose address changes.
- Press "Send a 1 cent test" once, to see that the name and IBAN are accepted.

Strava is optional (Settings, Strava). Creating a Strava API app needs a Strava subscription.

A key that starts with `sandbox_` connects to bunq's test environment with play money, which
is a safe way to watch the whole thing work first. Pasting a real key afterwards ends the
test: test penalties are dropped, the days so far count as practice, and real money stays
off until you switch it on again. Play money and real money never end up in the same books.

## Put it online

The app has to be reachable from your phone and has to run every night, so it needs a host.
It is set up for Vercel:

1. Import the repository in Vercel.
2. Add a Postgres database (Neon, from the Vercel Marketplace). It provides `DATABASE_URL`.
3. Add `APP_SECRET` and `CRON_SECRET` (see `.env.example`).
4. Deploy. `vercel.json` runs the nightly check every day at 02:30 UTC, which is after 03:00 in Amsterdam all year.

Opening the app also runs any check that is overdue, so a missed nightly run is caught up.

Notifications to the friend's phone need the app on HTTPS, which Vercel gives you. Your
own computer (below) is fine for trying things out, but a friend's phone can't install
the page or get notifications from it.

## Safety

- **Never pays twice.** Before any transfer the app reads the bank's payment list and looks for the reference. A transfer whose answer got lost is found there instead of being sent again.
- **Never guesses.** If Claude cannot be reached when a photo is uploaded, the photo is kept and checked again later, and its day waits for it (up to 72 hours, after which the photo counts without a check). A Strava outage works the same way. If the bank refuses or the account is empty, the penalty stays open and is retried.
- **Limits.** No single transfer can exceed €500, whatever the settings say.
- **Keys.** The bunq key, the Claude key and Strava tokens are stored encrypted. The app is behind one password, with a lockout after five wrong tries.
- **Photos** are sent to Anthropic's API to be read, and stored in the app's database. Your friend sees every one, with what Claude read from it.
- **Strava data** stays with you: the friend's page shows money and uploaded photos only, and activity details are deleted after 7 days.

## What it does not do

- It cannot make you pay. When your friend collects by hand, the app only tells them what to
  collect; the rest is between the two of you. Pick a friend who will chase you.
- It cannot stop your friend from giving the money back early. Pick a strict friend.
- Your friend's page is a secret link, and you can see it in Settings. Every "collected" and
  "given back" tap sends a notification to your friend's phone, so a tap they didn't make
  does not go unnoticed.
- Claude can be fooled by a well-made fake. Your friend sees every photo on their page, so a fake would have to fool them too.
- It does not ask for proof that you are sick. Three sick days a month is the whole allowance, and a fourth is a miss.
- It does not move the money on to an investment account. Brokers generally refuse deposits
  that come from someone else's bank account, so your friend sends the money back to you and
  the app marks it as returned. Putting it into your investments from there is up to you.

## Run it on your own computer

### Prerequisites

- [Node.js](https://nodejs.org) 20.9 or newer (CI uses 22) and npm
- Git
- Nothing else: locally the database is [PGlite](https://pglite.dev) (Postgres compiled to
  WebAssembly), stored in a folder inside the project. No Docker, no database server.
- Optional: a Claude API key (for the photo check), a bunq account (for bank transfers),
  a Strava API app

### Steps

1. Get the code and install the dependencies:

   ```bash
   git clone https://github.com/krishaanth5831/showup.git
   cd showup
   npm install
   ```

2. Start the app:

   ```bash
   npm run dev
   ```

3. Open **http://localhost:3000**. The first visit takes you to `/setup`, where you choose
   the app's password. The database (`./.data/pg`) and a secret key (`./.data/app-secret`)
   are created on first use. Both are ignored by git; deleting `.data` starts over.

4. Go to Settings to set your training days, rules, friend and keys (see "Use it for real"
   above). Until you switch on real money, nothing is charged.

No `.env` file is needed locally. A phone on the same Wi-Fi can open the app through the
computer's network address, which `npm run dev` prints as "Network". The app only runs
while that command is running, so the nightly check happens when you open the app (or press
"Check now" in Settings).

Just want to look around? `npm run demo` (see "Try it without connecting anything") uses its
own database in `./.data-demo` and never touches your real one.

### Environment variables

All of them are optional on your own computer. On Vercel, `DATABASE_URL`, `APP_SECRET`
and `CRON_SECRET` are required. Copy `.env.example` to `.env.local` if you want to set any
locally.

| Variable | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | On a server | Postgres connection string. `POSTGRES_URL` is accepted too. Without either, the app uses PGlite in `./.data` (and refuses to start on Vercel). |
| `APP_SECRET` | On a server | At least 32 random characters (`openssl rand -base64 48`). Encrypts the stored keys and signs the login. Locally one is generated in `./.data/app-secret`. Changing it means entering the keys again. |
| `CRON_SECRET` | On a server | Random text that Vercel Cron sends with the nightly check, so nobody else can trigger it. |
| `SHOWUP_TZ` | No | Time zone for all deadlines. Default `Europe/Amsterdam`. |
| `SHOWUP_DATA_DIR` | No | Where the local database and secret live. Default `./.data` (the demo uses `./.data-demo`). |
| `PUSH_CONTACT` | No | Contact address sent to push services with each notification. Default `mailto:showup@example.com`. |
| `HTTPS_PROXY` | No | Send outgoing requests (Claude, bunq, Strava, push) through a proxy. |
| `TEST_DATABASE_URL` | Tests only | Run `npm test` against a real Postgres server instead of the in-memory one. |
| `DEMO_TODAY` | Demo only | `run`, `strength`, `done` or `rest`: what today looks like in `npm run demo`. |
| `ANTHROPIC_API_KEY` | `check:claude` only | The app itself takes the Claude key in Settings, not from the environment. |

The Claude key, bunq key and Strava app details are entered in Settings and stored
encrypted in the database, never in environment variables or the repository. The push
notification keys (VAPID) are generated by the app on first use.

### Scripts

```bash
npm run dev          # the app on http://localhost:3000
npm run demo         # seeds made-up history, then the app on http://localhost:3210 (password printed)
npm run demo:seed    # only (re)seed the demo database
npm test             # rules, the nightly job, payments and returns, against a real in-memory Postgres
npm run lint
npm run typecheck
npm run build        # production build
npm start            # serve the production build (after npm run build)
npm run check:bunq   # the real bank code against bunq's sandbox (play money, needs internet)
ANTHROPIC_API_KEY=sk-ant-... npm run check:claude -- photo.jpg run   # one real photo check, a few cents
```

`check:claude` takes `<photo> <run|strength> [YYYY-MM-DD] [earlier.jpg@YYYY-MM-DD ...]`. The
day defaults to today; earlier photos (newest first, each with the day it proved) are what
the new one is compared with. It never touches the app's database.

### Troubleshooting

- **"APP_SECRET is too short"**: it needs at least 32 characters. `openssl rand -base64 48` makes a good one.
- **"No database configured" or "APP_SECRET is not set" on Vercel**: add a Postgres database to the project (it sets `DATABASE_URL`) and `APP_SECRET`, then redeploy. On Vercel the app refuses to fall back to the local database.
- **The nightly check answers "CRON_SECRET is not set"**: add `CRON_SECRET` to the project's environment variables. Until then, opening the app still catches up on overdue days.
- **The friend's phone can't install the page or turn on notifications**: it needs the deployed app on HTTPS. The local development server is only reachable over plain HTTP.
- **A photo is refused**: the reason is shown right away. The date has to be visible on the screenshot, and it has to be the training day.
- **Starting over locally**: stop `npm run dev` and delete the `.data` folder. This deletes your local history and stored keys.

## Tech stack

- [Next.js](https://nextjs.org) 16 (App Router, Cache Components) and React 19, TypeScript
- Postgres: `pg` on a server, PGlite on your own computer and in tests
- Tailwind CSS v4, Geist font, Phosphor icons
- Claude through the official `@anthropic-ai/sdk` (the photo check uses `claude-opus-5-5`)
- `web-push` for notifications, Zod for validation, Vitest for tests
- Vercel for hosting and the nightly cron (`vercel.json`)

## Project layout

```
app/
  (app)/            the owner's screens: Today (page.tsx), History, Settings
  f/[token]/        the friend's page and its own installable manifest
  setup/, login/    first-run password and sign-in
  api/cron/settle/  the nightly check that Vercel Cron calls
  api/proof/[id]/   serves an uploaded photo
  api/strava/       Strava connect and callback
  actions.ts        server actions for the owner; friend-actions.ts for the friend's page
  ui/               shared components (forms, upload, countdown, logo, ...)
lib/
  engine.ts         the rules: judging days, prices, caps, judgePhoto
  rules.ts          versioned rules (a change never rewrites history)
  settle.ts         the nightly job
  proofs.ts         photo uploads; claude.ts reads them
  collect.ts        friend-collects flow; push.ts notifications
  bunq.ts           bank transfers and matching returns; bank-switch.ts sandbox vs real
  strava.ts         optional Strava connection
  sick.ts           sick days
  db.ts, migrations.ts   Postgres / PGlite and the schema
  secrets.ts, auth.ts    encryption, password and sign-in
public/sw.js        service worker for notifications
scripts/            demo seeding, bunq sandbox check, one-off Claude photo check
tests/              Vitest suites (engine, nightly settle) and fakes
```

## Contributing

Issues and pull requests are welcome.

- Work happens on the `dev` branch. `main` is protected and only takes pull requests from
  `dev` (a required check enforces it), so open your pull request against `dev`.
- Before opening one, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`.
  CI runs the same checks, with the tests twice: once on the in-memory database and once on
  a real Postgres server.
- `CLAUDE.md` lists the things that must stay true (whole-cent money, never paying twice,
  versioned rules, what the friend's page may show). Please keep to them.
- Never commit keys, IBANs or personal data. Keys belong in the app's Settings, where they
  are stored encrypted.

## License

[MIT](LICENSE)
