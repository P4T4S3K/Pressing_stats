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

## Two operators with live sync

One operator records **Team A** (my team), the other records **Team B** (opponent), each on their own phone.
Both see the same match clock and the same live report. A coach can follow along with a *Report only* link.

1. Open the app and pick a **match code** (or keep the generated one).
2. Choose a role:
   - **Operator Team A**: only Team A's buttons, "We press" phase button
   - **Operator Team B**: only Team B's buttons, "Under pressure" phase button
   - **Report only**: live report without buttons (coach / bench)
   - **Both teams**: one device records everything
3. Tap **Match** (top right) to show links and QR codes for the other devices. Scan to join the same match.

Each operator starts and ends their own team's pressing phases. Either operator can start/pause the shared
clock. **Undo my last** only undoes taps made on that device. **Reset match** clears the match for everyone.
If the connection drops, taps are kept and synced when the phone is back online.

Live sync needs the one-time Firebase setup below. Without it, the app works on a single device as before.

### Live sync setup (one time, free)

1. Go to <https://console.firebase.google.com>, click **Create a project** (Google Analytics not needed).
2. In the project: **Build → Realtime Database → Create Database**, choose a location, start in **locked mode**.
3. Open the **Rules** tab, replace the rules with the following and click **Publish**:

   ```json
   {
     "rules": {
       ".read": false,
       ".write": false,
       "matches": {
         "$match": { ".read": true, ".write": true }
       }
     }
   }
   ```

   Anyone who knows a match code can read and write that match, so use codes that are not easy to guess
   (the generated 6-character codes are fine).
4. **Project settings** (gear icon) → **Your apps** → **Web** (`</>`) → register an app (no hosting needed).
   Copy the `firebaseConfig` object it shows.
5. Paste it into [`config.js`](config.js) as `window.PRESSING_FIREBASE_CONFIG = { ... };`, make sure it
   contains `databaseURL`, and commit. GitHub Pages redeploys automatically.

## Running

No build or installation needed — open `index.html` in any browser (desktop, tablet or phone).

To host it online, enable **GitHub Pages** in the repository settings
(*Settings → Pages → Deploy from branch → `main` / root*). The app will then be available at
`https://p4t4s3k.github.io/Pressing_stats/`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `config.js` | Firebase settings for live sync (`null` = this device only) |
| `store.js` | Match data: this device only or live via Firebase |
| `vendor/qrcode.js` | QR code generator (MIT, Kazuhiko Arase) |
| `style.css` | Team and button colours, layout |
| `app.js` | Roles, recording logic, report, CSV export |
