# Pressing Stats

A lightweight web app for recording **pressing** and **under-pressure** situations of two teams during a football match and showing a live statistics report.

## How it works

### What each operator records

Each team has two columns, one per situation:

| We press | Under pressure |
| --- | --- |
| phase button with timer | phase button with timer |
| 🟢 **Successful**: the press won the ball / forced the desired outcome | 🟢 **Successful**: escaped the press, kept the ball |
| 🔴 **Unsuccessful**: the press was beaten | 🔴 **Unsuccessful**: lost the ball under pressure |

Tap a phase button when the phase starts and tap it again when it ends; tapping the other phase button
switches directly. Operator 1 records Team A, Operator 2 records Team B. The match clock starts
automatically with the first phase. Click a team name to rename it.

### Report

For both teams, separately **when we press** and **when under pressure**: number of actions, successful,
unsuccessful, success rate, time, share of match time, number of phases, average and longest phase.
Plus the time balance *we press vs. under pressure*, success-rate bars, a **match timeline**
(solid bars = we press, striped = under pressure, round dots = actions when pressing, square dots = actions
under pressure), a breakdown per 20-minute period and an event log.

**Tapped by mistake?** Every team panel has a big **↶ Undo** button that shows exactly what it will remove
(e.g. *Unsuccessful · we press (12:30)*), and after each tap a short message appears at the bottom with an
**Undo** button. Undo works step by step, also for phase taps, and only removes taps made on that phone.

Extras: match clock, **Export CSV**, **Reset match**.
Data is stored in the browser (`localStorage`), so a page reload does not lose the match.

## Apps for each operator

| App | Link | Records |
| --- | --- | --- |
| **Operator 1** (blue) | <https://p4t4s3k.github.io/Pressing_stats/operator1.html> | Team A (my team): *We press* and *Under pressure*, each with Successful / Unsuccessful |
| **Operator 2** (orange) | <https://p4t4s3k.github.io/Pressing_stats/operator2.html> | Team B (opponent): *We press* and *Under pressure*, each with Successful / Unsuccessful |
| **Report** | <https://p4t4s3k.github.io/Pressing_stats/report.html> | nothing, live report for the coach |
| Both teams | <https://p4t4s3k.github.io/Pressing_stats/> | everything on one device |

Install each one on its phone as a separate app: open the link, then
**Android/Chrome:** menu ⋮ → *Add to Home screen* / *Install app*;
**iPhone/Safari:** Share → *Add to Home Screen*.
Each app has its own name, colour and icon (1, 2, R).

## One report from both operators (no internet needed during the match)

1. At kick-off, both operators tap **Start clock** at the same moment, so the times line up.
2. Operator 1 records Team A, Operator 2 records Team B, each on their own phone.
3. At half time or full time each operator taps **Send my stats → Share link** and sends the link
   (WhatsApp, SMS, e-mail) to the phone that shows the report (the coach, or one of the operators).
   Alternatively **Save as file** and send the file.
4. On the report phone, open each link: the stats are added to the **Report**, which then shows both teams.
   In an installed app you can also paste the link (or choose the file) under **Add stats**.

Sending again later replaces that team's earlier stats, so nothing is counted twice.

## Optional: live sync between operators

Not needed for the steps above. With a free Firebase project the two phones can also share one live match.

One operator records **Team A** (my team), the other records **Team B** (opponent), each on their own phone.
Both see the same match clock and the same live report. A coach can follow along with a *Report only* link.

1. Open the app and pick a **match code** (or keep the generated one).
2. Choose a role:
   - **Operator Team A**: only Team A's buttons
   - **Operator Team B**: only Team B's buttons
   - **Report only**: live report without buttons (coach / bench)
   - **Both teams**: one device records everything
3. Tap **Match** (top right) to show links and QR codes for the other devices. Scan to join the same match.

Each operator starts and ends their own team's pressing phases. Either operator can start/pause the shared
clock. **Undo** only undoes taps made on that device. **Reset match** clears the match for everyone.
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
| `config.js` | Optional Firebase settings for live sync (`null` = off) |
| `store.js` | Match data: on this device, or live via Firebase |
| `vendor/qrcode.js` | QR code generator (MIT, Kazuhiko Arase) |
| `style.css` | Team and button colours, layout |
| `app.js` | Roles, recording logic, report, sending / adding stats, CSV export |
