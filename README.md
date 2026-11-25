# FPL Desk

A Fantasy Premier League planner. It predicts points for every player over the next five gameweeks and compares your options each week: keep your team, the best transfers, Free Hit or Wildcard.

## Get the Android app

**[Download FPL-Desk.apk](https://github.com/Salazar-Slytherin-Vibe-Coding/fpl_desk/releases/latest/download/FPL-Desk.apk)**

1. Open the link on your Android phone and download the file.
2. Open it. Android will ask you to allow installs from your browser or Files app. Allow it, then tap **Install**.
3. Open FPL Desk and enter your FPL team ID. It's the number after `/entry/` on your Points page.

The app loads your squad, bank, free transfers and chips, and pulls live stats and injury news straight from FPL.

## How predictions work

Each player gets expected points per fixture under official FPL scoring. The inputs are:

- his share of his team's xG and xA
- the opponent's attack and defence strength
- clean-sheet and goals-conceded odds
- saves, defensive contributions, bonus and cards
- expected minutes, with recent games weighted most and FPL's chance-of-playing figure applied

Wildcard and Free Hit squads are found by searching for the most predicted points within your budget and the three-per-club rule.

Predictions are estimates. Selling prices aren't public, so current prices are used, and free transfers are worked out from your transfer history. Check both against the FPL app.

## Build

Every push to `main` builds a signed APK with GitHub Actions and publishes it as the latest release.
