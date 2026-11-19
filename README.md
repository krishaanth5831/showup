# Showup

Show up for your workouts, or pay up.

Showup is a small web app for one person. You pick the days you train. If a session is
missing when the day is over, the app sends real money from your bank account to a friend,
and every miss in a row costs more. The friend keeps it for a while and then sends it back.

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
3. **Settings, Photo check:** paste a Claude API key (console.anthropic.com, API keys, with
   some credit under Billing). Each check costs a few cents.
4. **Settings, Bank:** paste a bunq API key.
   - API keys need bunq Pro or Elite.
   - In the bunq app: Profile, Security & Settings, Developers, API keys.
   - Before pasting it anywhere, open the key's menu and switch on "Allow all IP addresses",
     otherwise bunq refuses a server whose address changes.
   - Press "Send a 1 cent test" once, to see that the name and IBAN are accepted.
5. Send your friend their link (Settings, friend's page).
6. Train in practice mode for a few days, then switch on real money. It starts the next day.

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

On your own computer no setup is needed: `npm run dev` starts the app on
http://localhost:3000 and the database lives in `./.data`. A phone on the same Wi-Fi can
open it through the computer's network address, which `npm run dev` prints as "Network".
The app only works while that command is running, and the nightly check then happens
when you open the app (or press "Check now").

## Safety

- **Never pays twice.** Before any transfer the app reads the bank's payment list and looks for the reference. A transfer whose answer got lost is found there instead of being sent again.
- **Never guesses.** If Claude cannot be reached when a photo is uploaded, the photo is kept and checked again later, and its day waits for it (up to 72 hours, after which the photo counts without a check). A Strava outage works the same way. If the bank refuses or the account is empty, the penalty stays open and is retried.
- **Limits.** No single transfer can exceed €500, whatever the settings say.
- **Keys.** The bunq key, the Claude key and Strava tokens are stored encrypted. The app is behind one password, with a lockout after five wrong tries.
- **Photos** are sent to Anthropic's API to be read, and stored in the app's database. Your friend sees every one, with what Claude read from it.
- **Strava data** stays with you: the friend's page shows money and uploaded photos only, and activity details are deleted after 7 days.

## What it does not do

- It cannot stop your friend from sending the money back early. Pick a strict friend.
- Claude can be fooled by a well-made fake. Your friend sees every photo on their page, so a fake would have to fool them too.
- It does not ask for proof that you are sick. Three sick days a month is the whole allowance, and a fourth is a miss.
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
ANTHROPIC_API_KEY=sk-ant-... npm run check:claude -- photo.jpg run   # one real photo check, a few cents
```

Built with Next.js, Postgres (PGlite locally) and Tailwind. The rules live in
`lib/engine.ts` (including `judgePhoto`), photo uploads in `lib/proofs.ts`, the photo check in
`lib/claude.ts`, the nightly job in `lib/settle.ts`, the bank in `lib/bunq.ts` and Strava in
`lib/strava.ts`.

## License

MIT
