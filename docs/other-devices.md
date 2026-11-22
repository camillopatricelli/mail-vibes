# Using Mail Vibes on another device

Mail Vibes has no server and no user account of its own. Everything it remembers lives in the
browser where you set it up: the list of accounts, Microsoft 365 organisations, colours,
preferences, the IMAP bridge and passwords, and the sign-ins. A new device (or another browser on
the same device) starts empty.

The easy way to set up a new device is **Copy to another device**: a link that carries your
whole setup. Mail, events and tasks are never in it: they always come straight from Google,
Microsoft or your mail server.

## Copy to another device

### What it copies

- Your accounts, with their names, short names and colours
- Microsoft 365 organisations (their public application and directory IDs)
- Preferences: language, theme, start page, default accounts, hidden calendars and task lists,
  notification choices, first day of the week, your Google Maps key
- The IMAP bridge (address and access key), IMAP account settings and mail rules
- **IMAP passwords** that the first device knows (entered in this session or remembered). Each
  keeps its "remember on this device" choice.

It can't copy **Google and Microsoft sign-ins**: they belong to one device, by design. On the new
device you sign in once to each of those accounts.

### How it's protected

The link is **encrypted** with a code of 8 characters that only the first device shows. Without
the code, the link reveals nothing. The link is valid for **24 hours**. It is the part after
`#` in the address, which browsers never send to the web server.

Send the link and the code by different routes (the simplest: read the code off the first
device's screen), and don't share either with anyone.

### Steps

1. On the device you already use: **Settings → Copy to another device**.
2. Send the link to the new device: **Share the link** (on phones and tablets: AirDrop, email,
   a chat to yourself…) or **Copy the link**. Keep the window open: it shows the **code**.
3. On the new device, open the link. Mail Vibes opens and asks for the code: type it.
4. Check the list of accounts and click **Set up this device**. This **replaces** anything already
   set up on the new device.
5. A **Sign in again** banner appears for each Google and Microsoft account. Click **Sign in** on
   each one.
6. **Settings → Turn on notifications**, if you want them on this device too.

### iPhone and iPad

On iPhone and iPad, Mail Vibes added to the Home Screen keeps its **own** storage, separate from
Safari. A link opened from Mail, Messages or the camera opens in Safari, so:

1. Open the app's address in **Safari** → **Share** → **Add to Home Screen** → **Add** (once).
2. Copy the link (on the iPad: long-press it → **Copy**).
3. Open Mail Vibes **from the Home Screen** → **Settings → Copy to another device** → paste the
   link into the box under the button → **Open**, then continue from step 3 above.

### Android

Open the link in **Chrome**. If you installed Mail Vibes as an app (Chrome menu → **Install
app**), Android may offer to open the link in it; either way the setup is shared between Chrome
and the installed app.

## With a settings file

The settings file is the older way, and also a backup you can keep. It holds the same settings
as the link, but **no passwords**, and the bridge's access key only if you choose so (**Include
address and key in the settings file**).

1. **Settings → Back up settings → Export to file**. A file named like
   `mail-vibes-settings-2026-11-21.json` is downloaded.
2. Get it onto the new device (email, OneDrive, Google Drive…).
3. On the new device: **Settings → Back up settings → Import from file**, and pick the file.
   On iPhone and iPad, do this from the app opened from the Home Screen.
4. Sign in to each account where a banner asks, and type each IMAP password once.

## Without either

1. **Microsoft 365:** on the first device, **Settings → Microsoft 365 organisations**, use the
   link button next to the organisation to copy its **setup link**, and open that link on the
   new device. (Or **Add organisation** and type the two IDs.)
2. **Settings → Add Microsoft 365 account / Add Google account / Add IMAP account** for each
   account.
3. Set colours, names and preferences again.

## Good to know

- **Devices don't sync.** A change made on one device (a new account, a colour, a hidden
  calendar, a rule for an IMAP account) stays on that device. To copy it, use Copy to another
  device again.
- **Sign-ins are per device.** Signing out or removing an account on one device doesn't affect
  the others. To cut off a lost device, revoke access from the account itself: Google Account →
  *Security* → *Your connections to third-party apps*; Microsoft: *My Sign-ins* → sign out
  everywhere, or ask your administrator. For IMAP accounts, change the password.
- **Google sign-ins last one hour** in a browser-only app. When one expires, Mail Vibes shows
  *Sign in again*; one click usually renews it. While the app's Google project is in
  *Testing* mode, Google also asks you to approve the app again once a week.
- **Notifications** appear only while Mail Vibes is open on that device (in the background is
  fine). They are turned on separately on each device.
- **IMAP rules** run on every device where Mail Vibes is open, on mail that arrives while it is
  open there.
- **Clearing the browser's data** for the site erases the setup on that device. Copy it again
  from another device.
