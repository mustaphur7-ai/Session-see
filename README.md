# XAUUSD Levels

A GitHub Action runs three times a day, Monday to Friday, and writes levels.json from the GLD options chain:

| Session | Kenya time (EAT) | UTC |
|---|---|---|
| Asian | 03:30 | 00:30 |
| London | 12:00 | 09:00 |
| New York | 17:33 | 14:33 |

The page only reads levels.json, so the options-derived levels stay frozen until the next of the three runs. Spot price, candles, market profile and prior highs and lows come live from Binance in the browser.

All files live in the repo root except the workflow, which must be at .github/workflows/analyze.yml.

## Setup
1. Create a new public GitHub repository.
2. Add every file to the repo root. Create the workflow as .github/workflows/analyze.yml (use "Create new file" and type that path).
3. Settings > Actions > General > Workflow permissions: choose "Read and write permissions" and save.
4. Settings > Pages: Source "Deploy from a branch", branch main, folder / (root), save.
5. Actions tab > "Daily levels analysis" > Run workflow. When it finishes, the sample banner disappears.

## Notes
- GitHub cron can run several minutes late. The page shows the real analysis time and session.
- The ladder's Chg column compares each strike with the previous run (field change_1d in levels.json).
- The stale-data warning fires after 14 hours Tuesday to Friday, and after 62 hours over the weekend and on Monday.
- Before the US market opens (the Asian and London runs) GLD options show the previous close and previous open interest, so those two sets of levels are a little less fresh than the New York set.
- The GLD-to-gold ratio uses the gold price at the moment GLD last traded (from Binance), so overnight gold moves do not shift the levels. If that lookup fails it falls back to the gold price now.
