# Using Mail Vibes on another device

Mail Vibes has no server and no user account of its own. Everything it remembers lives in the
browser where you set it up: the list of accounts, Microsoft 365 organisations, colours,
preferences, and the sign-ins. A new device (or another browser on the same device) starts empty.

To move your setup, you copy a **settings file** from the first device and sign in again on the
new one. Mail, events and tasks are never in the file: they always come straight from Google and
Microsoft.

## What the settings file contains

- Your accounts' email addresses, names, short names and colours
- Microsoft 365 organisations (their public application and directory IDs)
- Preferences: language, theme, start page, default accounts, hidden calendars and task lists,
  notification choices, first day of the week
- Your Google Maps key, if you set one

It does **not** contain passwords, sign-ins (tokens), mail, events, tasks or contacts. It is not
secret in the way a password is, but it lists your addresses, so keep it to yourself.

## 1. On the device you already use

1. Open Mail Vibes → **Settings** (gear icon) → **Back up settings** → **Export to file**.
2. A file named like `mail-vibes-settings-2026-11-21.json` is downloaded.
3. Get it onto the new device: e-mail it to yourself, or put it in OneDrive, Google Drive or
   similar.

## 2. On the new device

### Computer

1. Open the app's address in the browser (the same one you use now).
2. Optional: install it as an app with the install icon in the address bar, or the browser menu
   → *Install app*.
3. **Settings → Back up settings → Import from file** and choose the file.
4. A **Sign in again** banner appears for each account. Click **Sign in** on each one and sign in
   as usual.
5. **Settings → Notifications and app → Turn on notifications**, if you want them on this
   device too.

### Android phone or tablet

1. Open the app's address in **Chrome**.
2. Chrome menu (⋮) → **Install app** (or *Add to Home screen*). Open Mail Vibes from the new icon.
3. In the installed app: **Settings → Import from file**, and pick the file (from Downloads,
   Drive, or wherever you saved it).
4. Click **Sign in** on the **Sign in again** banner of each account.
5. Turn on notifications in Settings.

### iPhone or iPad

On iPhone and iPad, the app added to the Home Screen keeps its **own** storage, separate from
Safari. So install it first, and do everything else from inside the installed app.

1. Open the app's address in **Safari**.
2. **Share** button → **Add to Home Screen** → **Add**.
3. Open Mail Vibes from the Home Screen icon (not from Safari).
4. **Settings → Import from file**, and pick the file (from Files, iCloud Drive, or a mail
   attachment saved to Files).
5. Click **Sign in** on the banner of each account. Microsoft sign-in opens as a full page and comes back to the app.
6. **Settings → Turn on notifications**. iOS only allows notifications for apps added to the
   Home Screen (iOS 16.4 or later).

## Without a settings file

You can also set up the new device by hand:

1. **Microsoft 365:** on the first device, **Settings → Microsoft 365 organisations**, use the
   link button next to the organisation to copy its **setup link**, and open that link on the
   new device. (Or **Add organisation** and type the two IDs.)
2. **Settings → Add Microsoft 365 account / Add Google account** for each account.
3. Set colours, names and preferences again.

## Good to know

- **Devices don't sync.** A change made on one device (a new account, a colour, a hidden
  calendar) stays on that device. To copy it, export again and import on the other device.
  Importing **replaces** all the settings on that device.
- **Sign-ins are per device.** Signing out or removing an account on one device doesn't affect
  the others. To cut off a lost device, revoke access from the account itself: Google Account →
  *Security* → *Your connections to third-party apps*; Microsoft: *My Sign-ins* → sign out
  everywhere, or ask your administrator.
- **Google sign-ins last one hour** in a browser-only app. When one expires, Mail Vibes shows
  *Sign in again*; one click usually renews it. While the app's Google project is in
  *Testing* mode, Google also asks you to approve the app again once a week.
- **Notifications** appear only while Mail Vibes is open on that device (in the background is
  fine). They are turned on separately on each device.
- **Clearing the browser's data** for the site erases the setup on that device. Import the file
  again to restore it.
