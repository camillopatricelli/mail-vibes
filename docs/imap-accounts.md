# IMAP and PEC accounts

Besides Google and Microsoft 365, Mail Vibes can show **any mailbox that offers IMAP** (to read)
and, optionally, **SMTP** (to send): a hosting provider's mailbox, a self-hosted server, or an
Italian **PEC** (certified email) mailbox. These accounts have **mail only**: no calendar, tasks
or contacts.

Browsers can't speak IMAP or SMTP, so these accounts go through a small **bridge** that you run
for free on your own Cloudflare account. Set it up first: [imap-bridge.md](imap-bridge.md).

## Adding an account

1. In **Settings**, check that the **IMAP bridge** section shows your bridge, and that **Check
   bridge** says it answers.
2. Click **Add IMAP account** and type the email address.
3. Click **Find settings**. Mail Vibes looks for the provider's published settings (Thunderbird's
   database, the provider's own configuration file, or DNS records). Always check what it found
   against your provider's instructions. If nothing is found, enter the settings by hand:
   - **Incoming (IMAP):** server name, port **993** with **SSL/TLS** (or 143 with STARTTLS), user
     name. The user name is often the email address, but some providers use a user ID.
   - **Outgoing (SMTP):** tick **Send mail from this account** and enter the server, port **465**
     with **SSL/TLS** (or 587 with STARTTLS) and user name. Leave it unticked for a mailbox you
     only want to read.
4. Type the password. If your provider offers **app passwords**, use one instead of your main
   password: some providers accept only those (see [App passwords](#app-passwords)).
5. Choose whether to **remember the password on this device** (see [Passwords](#passwords)).
6. For a PEC mailbox, tick **This is a PEC (certified email) mailbox** (see [PEC](#pec-mailboxes)).
7. Click **Add**. Mail Vibes signs in once to check the user name and password.

### App passwords

Some providers refuse your usual password from any mail app but their own, and want an **app
password** instead: a separate password that the provider generates for one app, and that you
can delete at any time without changing your main password.

| Provider | Where to make one | Incoming (IMAP) | Outgoing (SMTP) |
| --- | --- | --- | --- |
| Yahoo Mail | login.yahoo.com → **Account security** → **Generate app password** | `imap.mail.yahoo.com`, 993, SSL/TLS | `smtp.mail.yahoo.com`, 465, SSL/TLS |
| AOL Mail | login.aol.com → **Account security** → **Generate app password** | `imap.aol.com`, 993, SSL/TLS | `smtp.aol.com`, 465, SSL/TLS |
| iCloud Mail | account.apple.com → **Sign-In and Security** → **App-Specific Passwords** | `imap.mail.me.com`, 993, SSL/TLS | `smtp.mail.me.com`, 587, STARTTLS |

- The user name is the full email address. For iCloud, it is the part before `@`.
- If the provider doesn't offer app passwords, turn on **two-step verification** in the same
  security page first: the option often appears only after that.
- Copy the app password exactly as shown (spaces don't matter) and paste it as the password in
  Mail Vibes.
- Gmail and Microsoft accounts don't need this: add them with **Add Google account** or **Add
  Microsoft 365 account** instead of IMAP, which also gives you their calendars, tasks and
  contacts.

### Special folders

Sent, Drafts, Bin, Spam and Archive are found automatically: from the server's own labels when it
has them, otherwise by their usual names in several languages ("Sent", "Posta inviata",
"Spedite"…). If the app picks the wrong one, choose it under **Special folders** when you edit
the account. If the mailbox has no Archive folder, Mail Vibes creates one the first time you
archive something.

## Passwords

- By default the password is kept **only while Mail Vibes is open**. After you close or reload it,
  the app asks again.
- **Remember the password on this device** stores it **encrypted** in this browser, with a key the
  browser never reveals: copying the browser's files to another computer doesn't expose it. But
  anyone using this browser on this device can open Mail Vibes and read your mail, so don't use it
  on shared devices.
- Passwords are **never** in the settings, in the settings export file or in any log.
  **Settings → Copy to another device** carries them (encrypted, behind a one-time code); with a
  settings file instead, you type each password again on the other device (see
  [other-devices.md](other-devices.md)).

## What works, and how it differs from Gmail and Outlook

IMAP is older and simpler than Gmail and Outlook, so a few features work differently:

| Feature | How it works on IMAP accounts |
| --- | --- |
| Conversations | Built by the app from the messages' reply headers. |
| Search | Done by your mail server, in the Inbox, Sent, Archive and your own folders (not Bin, Spam, Drafts). On PEC mailboxes only the subject and sender are searched, because PEC servers search message text very slowly. |
| Tags | Saved on the messages as IMAP *keywords*, which other mail programs such as Thunderbird also show. Important, Work, Personal, To Do and Later are Thunderbird's own five tags. |
| Snooze, send later | Messages wait in folders named after their time (for example `Mail Vibes / Snoozed / 2026-11-23 09h00`), which the app hides from its folder list and deletes when empty. Other mail programs may show them greyed out. |
| Sending later | Mail Vibes sends the message itself when the time comes, **only while it is open** on one of your devices; otherwise as soon as you open it. |
| Mail rules | IMAP servers have no rules Mail Vibes can use, so the app keeps them in its settings and applies them to **new Inbox mail, only while it is open**. Mail that arrived while it was closed is handled when you open it. Mail you move back to the Inbox (or that comes back from snooze) is left alone. |
| Notifications, unread counts | Checked every minute or so while the app is open (Settings → **Check for new items every**). |
| Delete forever | Available, as for Microsoft 365 accounts. |
| Full mailbox | If the server reports its storage, Mail Vibes warns when the mailbox is 90% full. |

## PEC mailboxes

A PEC message arrives as an envelope from your PEC provider containing the original message. For
PEC accounts Mail Vibes:

- shows the **original message** (its real sender, subject, text and attachments) with a **PEC**
  box holding the certification details: type, date, sender, recipients and message ID;
- groups **receipts** (acceptance, delivery, failed delivery…) with the message they are about,
  so they don't clutter the Inbox;
- lets you **forward as a normal email** from another account that can send (the default is your
  default sending account). The forward attaches the full certified original as an `.eml` file
  as proof. It is a normal email: it has **no PEC legal value**;
- **asks before deleting** a PEC message, because it is a legal record;
- warns when the mailbox is nearly full: a full PEC mailbox refuses certified mail sent to you.

Mail Vibes is meant to **read** PEC mailboxes. Usually you add them without an outgoing server
(receive only) and keep sending PEC from your provider's webmail. If you add the account as an
ordinary IMAP account, Mail Vibes notices PEC messages and offers to mark it as PEC.

## Troubleshooting

| What happens | What to check |
| --- | --- |
| The app asks for the password every time | Tick **Remember the password on this device** (edit the account), or accept that it asks once per session. |
| "The server refused the password" | The user name (not always the email address) and, if your provider has them, an [app password](#app-passwords): Yahoo, AOL and iCloud refuse the usual password. |
| Bridge errors | See the troubleshooting table in [imap-bridge.md](imap-bridge.md). |
| A folder shows old messages, or a message seems missing | Reload the list. If it persists, check in your provider's webmail: Mail Vibes shows what the server has. |
| Mail sent to the account never arrives (also not in the webmail) | Nothing in Mail Vibes can stop mail from arriving. Ask whoever manages the domain's mail to check where its **MX records** point, and any spam filter or mail gateway in front of the mailbox. |
| A rule didn't run | Rules run only while Mail Vibes is open, and only on new Inbox mail. If the rule's folder was deleted, the app says so once. |
