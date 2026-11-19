# Showup

A one-person commitment app: fixed training days, every session proven by a workout photo
that Claude reads (Strava optional for runs), and a real bank transfer to a friend for every miss.
Read `README.md` for how it works and `AGENTS.md` for the Next.js version notes.

## Branch rules

- Two branches: `main` and `dev`. All work is committed on `dev`.
- `main` is protected. It only changes through a pull request from `dev`, enforced by the
  required check `only-dev-into-main`.
- Open the pull request with `--base main`. Never merge it: the owner is the only one who merges.
- Check a pull request's real state on GitHub before talking about it.

## Things that must stay true

- Money is whole cents, days are `YYYY-MM-DD` text in the app's time zone, bank and Strava ids are text.
- A judged day never changes. Rules are versioned by start date, so a rule change never rewrites history.
- A transfer is never sent without first reading the bank's payment list and looking for its
  reference (`SHOWUP-YYYYMMDD`). That is what prevents paying twice.
- A sick day is neutral: no charge, and the count of misses in a row is carried through it
  unchanged (it neither grows nor resets). It can only be used until 03:00 the next morning,
  proof of a done session wins over it, and the monthly limit lives in the versioned rules.
- Claude only reads a photo. Whether it counts is decided in code (`judgePhoto` in `lib/engine.ts`).
- A photo that fails the check is never stored. One that can't be checked (Claude unreachable) is
  kept as "waiting", holds its day for up to 72 hours, then counts unchecked. An outage never becomes a miss.
- The friend's page shows money and uploaded photos only, never Strava data (Strava's API terms).
- Strava activity details are deleted after 7 days (same terms).
- No secrets, IBANs or personal data in the repository. Keys live encrypted in the database.

## Commands

- `npm run demo` seeds made-up history and opens the app on http://localhost:3210 (password printed in the terminal).
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
- `npm run check:bunq` runs the real bank code against bunq's sandbox (play money, needs internet).
- `ANTHROPIC_API_KEY=... npm run check:claude -- <photo> <run|strength> [day] [earlier.jpg@day ...]` runs one real photo check (costs a few cents).
- Scripts run as `node --import tsx <file>`.
