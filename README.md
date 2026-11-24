# Lone Worker Safety

A simple app that keeps onsite engineers safe when they work alone.

- **Engineers** open it on their phone, start a shift, and tap **"I'm OK"** every hour.
- If they **miss a check-in**, or **hold the SOS button for 3 seconds**, the office and on-call staff are alerted with the engineer's last known location.
- The **office dashboard** shows who is on shift, when each person is next due, where they are, and any alerts that need dealing with.

It is a web app, so it works on any phone (iPhone or Android) through the browser. Engineers can add it to their home screen so it looks and opens like a normal app. No app store needed.

---

## How it works, step by step

### For engineers (phone)
1. Open the app link and sign in with your **username and PIN**.
2. The first time, read the short privacy notice and tap **I understand**.
3. When you arrive on site, type the site name and tap **Start shift**. Your phone will ask to share your location: tap **Allow**.
4. A countdown shows when your next check-in is due (every **60 minutes** by default). Your phone buzzes 5 minutes before.
5. Tap the big green **I'm OK – check in** button before the countdown runs out.
6. In an emergency, **press and hold the red SOS button for 3 seconds**. The office and on-call staff get your location straight away.
7. When you leave site, tap **End shift**. Location sharing stops.

**Tip:** add it to your home screen. On iPhone: Share button → *Add to Home Screen*. On Android: menu (⋮) → *Install app* or *Add to Home screen*.

### For the office (computer)
1. Go to the app link with `/manager` on the end (for example `https://your-app-address/manager`).
2. The very first time, create the main manager account.
3. **Engineers & staff** tab: add each engineer with a username and a 4 to 8 digit PIN. Add office colleagues as "Office / manager" so they can use the dashboard too.
4. **Office & on-call** tab: add the people who should be alerted (phone and/or email).
5. **Live** tab: keep this open in the office. It refreshes itself and beeps when a new alert arrives.
6. When an alert comes in, phone the engineer, then type what you did and press **Mark as dealt with**.

### What happens when someone misses a check-in
| Time | What happens |
|---|---|
| Check-in due | Engineer's phone buzzes; countdown turns red |
| 5 minutes late (grace period) | Alert raised. Office/managers and on-call contacts are notified |
| 10 more minutes with nobody marking it dealt with | Everyone is notified again as an **escalation** |
| Engineer checks in late | Alert closes automatically and an "all clear" goes to the office |

An **SOS** notifies everyone immediately, and escalates again after 10 minutes if no one has marked it as dealt with. The engineer cannot end the shift until the office has cleared the SOS.

All of these times can be changed in the **Settings** tab.

---

## What is not finished yet (needs your accounts)

1. **Text messages / emails are not actually sent yet.** Alerts appear on the dashboard (with a sound) and every message that *would* be sent is listed under **History → Messages**. To send real texts, sign up to an SMS service such as **Twilio** (pay-as-you-go, roughly 4p per UK text). The code to connect it goes in `lib/notify.js`.
2. **Hosting.** The app needs to run on a server with a web address (with `https://`, which phones require for location). Low-cost options include Render, Railway or Fly.io (a few pounds a month). Phones cannot use it until it is hosted.
3. **Phone in pocket / screen locked.** A web app cannot keep running in the background when the phone is locked, so location only updates while the app is open. **Missed check-ins are still detected**, because the server is watching the clock, not the phone. If you later need background tracking or "man down" fall detection, that needs a proper app-store app.

---

## GDPR and privacy (UK)

Tracking employees' location is personal data, so the app has been built with UK GDPR in mind:

- **Only during shifts.** Location is collected only while a shift is running, and stops when it ends.
- **Told up front.** Engineers see a privacy notice and must accept it before their first shift.
- **Automatic deletion.** Location history is deleted after **30 days** by default (change in Settings).
- **Access and deletion.** On the *Engineers & staff* tab you can **Download data** for any person (a subject access request), and **Erase all their data** after they leave.
- **Secure sign-in.** PINs and passwords are stored scrambled (hashed), and repeated wrong guesses lock the account for 5 minutes.

**Things you should do as the employer** (the app can't do these for you):
- Write a short **privacy notice** for lone working and give it to staff. Lawful basis is usually *legal obligation* (Health and Safety at Work Act / Management of Health and Safety at Work Regulations require you to manage lone-working risks) and/or *legitimate interests*.
- Carry out a **Data Protection Impact Assessment (DPIA)**. The ICO recommends one for location tracking of employees. The ICO website has a free template.
- Make sure your company is **registered with the ICO** (most businesses pay a small annual data protection fee).
- If you use Twilio or a hosting company, they are your **data processors**; check they offer a UK/EU data processing agreement.
- Keep the retention period as short as you genuinely need.

This is general guidance, not legal advice.

---

## For developers

No external packages are needed. You need Node.js 20 or newer.

```bash
npm start          # runs on http://localhost:3000 (dashboard at /manager)
npm test           # runs the automated tests
```

Settings via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_FILE` | `data/db.json` | Where data is saved |

Layout:
- `server.js` – web server and API
- `lib/safety.js` – shift, check-in, SOS, missed check-in and escalation rules
- `lib/notify.js` – sending alerts (stubbed: plug in SMS/email here)
- `lib/auth.js` – sign-in, PIN/password hashing
- `lib/store.js` – simple JSON file storage (move to a real database as you grow)
- `public/` – the engineer app (`index.html`, `worker.js`) and office dashboard (`manager.html`, `manager.js`)
- `test/` – automated tests

Data is kept in a single JSON file, which suits a small team on one server. Back up `data/db.json`, and switch to a database such as Postgres before running more than one server.
