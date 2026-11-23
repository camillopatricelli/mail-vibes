# Reminders while Mail Vibes is closed

Mail Vibes has no server of its own, so on its own it can only notify you while it is open.
Phones and tablets freeze apps that aren't on screen after a few minutes, and from then on a web
app can't ring at all.

Your **bridge** can fix that for **event and task reminders**. When Mail Vibes is open on any of
your devices, it hands the bridge the reminders of the coming week. When one is due, the bridge
sends it as a **push notification** to every device where you turned this on. Android, iPhone and
iPad, Windows and Mac show it even when Mail Vibes is closed or the screen is off.

New-mail notifications still appear only while Mail Vibes is open.

## What is sent, and what the bridge can see

- Each reminder (title, time, place, meeting link) is **encrypted on your devices** with a key
  that only your devices have. The bridge stores the **times** of your reminders and text it
  **can't read**, and forwards that text unchanged.
- The push services (Google's for Android and Chrome, Apple's, Microsoft's, Mozilla's) carry
  only that unreadable text.
- The key is made on the first device where you turn this on, and **Copy to another device**
  carries it to the others. On each device it is kept like a remembered IMAP password.
- The bridge only accepts your access key, and only sends to those push services.
- Reminders are kept until they are sent (at most a week ahead). If nobody opens Mail Vibes for
  a month, the bridge forgets them.

## What you need

- Your bridge ([imap-bridge.md](imap-bridge.md)), on the latest `worker.js`.
- A free Cloudflare **D1** database (a small storage space) and a **cron trigger** (a timer) for
  the bridge. Both are part of the free plan.
- On iPhone and iPad: Mail Vibes added to the Home Screen (iOS 16.4 or later).

## Setting it up

1. **Create the database.** In the Cloudflare dashboard: **Storage & databases → D1 SQL
   database → Create**. Name it `mail-vibes-push`, leave the rest as it is, click **Create**.
2. **Connect it to the bridge.** **Compute (Workers) → Workers & Pages →** your bridge
   (`mail-vibes-bridge`) **→ Settings → Bindings → Add binding → D1 database**. Variable name:
   `DB` (exactly, in capitals). Database: `mail-vibes-push`. Click **Add binding** (and **Deploy**
   if asked).
3. **Add the timer.** Same page: **Settings → Trigger events → Add → Cron Triggers**. Choose
   **Every minute** (the expression is `* * * * *`) and click **Add**.
4. **Update the bridge's code** to the latest `worker.js`
   ([Updating the bridge](imap-bridge.md#updating-the-bridge)).
5. In Mail Vibes: **Settings → IMAP bridge → Check**. It should say the bridge can send
   reminders.
6. On the device that has all your accounts (usually the computer): **Settings → Notifications →
   Remind me even when the app is closed**, and allow notifications if asked.
7. **Settings → Copy to another device** to each phone or tablet (this carries the reminders
   key), then turn on **Remind me even when the app is closed** on each of them too.

With Wrangler instead of the dashboard: `npx wrangler d1 create mail-vibes-push`, then uncomment
the `[[d1_databases]]` and `[triggers]` sections in [`bridge/wrangler.toml`](../bridge/wrangler.toml),
put in the database id, and run `npx wrangler deploy`.

## Good to know

- **Also when an event starts** (Settings → Notifications, on by default) adds a notification at
  the start time of each event, besides its reminders. Not for all-day events.
- A reminder can be **up to a minute late**: the bridge looks once a minute.
- The bridge learns about a new or changed event only once **Mail Vibes is open on one of your
  devices**. An event you add on your phone in another app gets its reminder after that. A
  computer with Mail Vibes open keeps everything up to date.
- If a device is off or offline when a reminder is due, the reminder is still delivered when it
  comes back, as long as that is within the hour.
- When Mail Vibes is open and shows a reminder itself, the pushed copy replaces it rather than
  ringing twice.
- To stop on one device, turn the switch off there. To stop everywhere, remove the cron trigger
  (or the `DB` binding) from the bridge.
- The free plan easily covers this: the bridge wakes up once a minute and stores a few kilobytes.

## Troubleshooting

| What happens | What to check |
| --- | --- |
| Settings says the bridge isn't set up for reminders | The binding must be called exactly `DB`, and the bridge updated afterwards. Then **Check** again. |
| No reminder arrives with the app closed | The **cron trigger** exists; the switch is on **on that device**; notifications for Mail Vibes are allowed in the phone's settings; battery saving doesn't block Chrome (Android). |
| A reminder shows only "Mail Vibes" | That device doesn't have the reminders key: copy the setup to it again (**Copy to another device**), then turn the switch off and on. |
