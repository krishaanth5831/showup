# Showup

Show up for your workouts, or pay up.

Showup is a small web app for one person. You pick the days you train. If a session is
missing when the day is over, the app sends real money from your bank account to a friend,
and every miss in a row costs more. The friend keeps it for a while and then sends it back.

## How it works

**Training days.** The default week is run on Monday, Wednesday and Saturday, strength on
Tuesday and Friday. Only those days count, and each one has its own deadline: midnight.

**Proof.**

- A run is read from Strava. It must be a recorded run (not typed in by hand) of at least 3.5 km, started on that day.
- A strength session is a screenshot of the workout from your watch, uploaded on that day. A strength workout on Strava also counts.

**Judging.** Each day is judged at 03:00 the next morning, so a late sync from your watch
still counts. A screenshot can be uploaded until 03:00 as well.

**The price.**

| Miss in a row | Cost |
| --- | --- |
| 1st | €10 |
| 2nd | €20 |
| 3rd | €40 |
| 4th and later | €80 (the most for one miss) |

A week (Monday to Sunday) never costs more than €150. A completed session sets the count
back to one. All of these numbers can be changed in Settings.

**The money.** Each penalty is its own bank transfer to your friend, with a reference like
`SHOWUP-20261123`. Your friend gets a private link showing what they hold and when each
transfer is due back (14 days by default). When they send money back with "showup" in the
description, the app marks it as returned by itself.

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

1. Start the app (`npm run dev`, or deploy it, see below) and choose a password.
2. **Settings, Rules:** enter your friend's full name and IBAN.
3. **Settings, Bank:** paste a bunq API key.
   - API keys need bunq Pro or Elite.
   - In the bunq app: Profile, Security & Settings, Developers, API keys. Paste the key within the hour.
   - Open the key's menu and switch on "Allow all IP addresses", otherwise bunq refuses a server whose address changes.
   - Press "Send a 1 cent test" once, to see that the name and IBAN are accepted.
4. **Settings, Strava:** create an API app at strava.com/settings/api (Strava asks for a
   subscription for this), paste its Client ID and Client Secret, then press Connect Strava.
   The callback domain to enter at Strava is shown on the Settings page.
5. Send your friend their link (Settings, friend's page).
6. Train in practice mode for a few days, then switch on real money. It starts the next day.

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

On your own computer no setup is needed: the database lives in `./.data`. The nightly check
then only runs while the app is running and you open it (or press "Check now").

## Safety

- **Never pays twice.** Before any transfer the app reads the bank's payment list and looks for the reference. A transfer whose answer got lost is found there instead of being sent again.
- **Never guesses.** If Strava cannot be reached, the day waits (up to 72 hours) instead of being charged. If the bank refuses or the account is empty, the penalty stays open and is retried.
- **Limits.** No single transfer can exceed €500, whatever the settings say.
- **Keys.** The bunq key and Strava tokens are stored encrypted. The app is behind one password, with a lockout after five wrong tries.
- **Strava data** stays with you: the friend's page shows money and uploaded screenshots only, and activity details are deleted after 7 days.

## What it does not do

- It cannot stop your friend from sending the money back early. Pick a strict friend.
- It does not judge what is on a screenshot. Your friend can see every screenshot on their page.
- There are no sick days. A miss is a miss.
- It does not move the money on to an investment account. Brokers generally refuse deposits
  that come from someone else's bank account, so your friend sends the money back to you and
  the app marks it as returned. Putting it into your investments from there is up to you.

## Development

```bash
npm test             # rules, the nightly job, payments and returns, against a real in-memory Postgres
npm run lint
npm run typecheck
npm run build
npm run check:bunq   # the real bank code against bunq's sandbox (play money, needs internet)
```

Built with Next.js, Postgres (PGlite locally) and Tailwind. The rules live in
`lib/engine.ts`, the nightly job in `lib/settle.ts`, the bank in `lib/bunq.ts` and Strava
in `lib/strava.ts`.

## License

MIT
