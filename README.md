# Pressing Stats

A lightweight web app for recording **pressing actions** of two teams during a football match and showing a live statistics report.

## How it works

### Pressing phases – who is pressing now?

At the top there are two big toggle buttons:

- 🔵 **We press** – *my team* (Team A) is pressing.
- 🟠 **Under pressure** – the *opponent* (Team B) is pressing us.

Tap a button when a pressing phase starts and tap it again when it ends. Tapping the other button
switches directly. The match clock starts automatically with the first phase.

The report shows for both sides: total pressing time, share of match time, share of pressing time,
number of phases, average and longest phase, a pressing-time balance bar, a **match timeline**
(phases as bars, pressing actions as dots) and pressing time per 15-minute period.

### Pressing actions

- Each team has its own panel and colour (**Team A – blue**, **Team B – orange**).
- In each panel there are just two buttons:
  - 🟢 **Successful** – the press won the ball / forced the desired outcome
  - 🔴 **Unsuccessful** – the press was beaten
- Click a team name to rename it.
- The **Report** below the buttons updates instantly:
  - total, successful and unsuccessful pressing actions per team
  - success rate and share of all pressing actions
  - success-rate bars
  - breakdown by 15-minute periods (uses the optional match clock)
  - event log
- Extras: match clock, **Undo last** (also undoes phase changes), **Export CSV**, **Reset match**.
- Data is stored in the browser (`localStorage`), so a page reload does not lose the match.

## Running

No build or installation needed — open `index.html` in any browser (desktop, tablet or phone).

To host it online, enable **GitHub Pages** in the repository settings
(*Settings → Pages → Deploy from branch → `main` / root*). The app will then be available at
`https://p4t4s3k.github.io/Pressing_stats/`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Team and button colours, layout |
| `app.js` | Recording logic, report, CSV export |
