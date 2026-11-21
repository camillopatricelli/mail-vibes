# Microsoft 365 setup

Each Microsoft 365 organisation needs its own app registration in Microsoft Entra. This is done
once by an administrator of the organisation. No client secret is needed: the app is a
single-page application that signs in with PKCE.

## 1. Register the app

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations**
   (under *Entra ID*, or *Identity → Applications* in older menus) → **New registration**.
2. **Name:** `Mail Vibes` (any name works).
3. **Supported account types:** *Accounts in this organizational directory only*.
4. **Redirect URI:** platform **Single-page application (SPA)**, with the address where the app
   runs, for example `https://<user>.github.io/mail-vibes/`. For local development, also add
   `http://localhost:5173`.
5. Select **Register**. From the overview page, note the **Application (client) ID** and the
   **Directory (tenant) ID**: these are what users enter in Mail Vibes (or receive in a setup link).

## 2. API permissions

In the app registration, open **API permissions** → **Add a permission** → **Microsoft Graph** →
**Delegated permissions**, and add:

| Permission | Used for |
| --- | --- |
| `User.Read` | Name and email of the signed-in user |
| `Mail.ReadWrite` | Reading, moving and flagging mail; drafts |
| `Mail.Send` | Sending mail |
| `Calendars.ReadWrite` | Calendars, events and invitation replies |
| `Tasks.ReadWrite` | Microsoft To Do |
| `Contacts.ReadWrite` | Address suggestions and "add to contacts" |
| `openid`, `profile`, `offline_access` | Sign-in and staying signed in |

Then select **Grant admin consent for &lt;organisation&gt;** and confirm. Without admin consent,
users see "Need admin approval" (error AADSTS90094) when they sign in. Users may otherwise be
allowed to consent for themselves, depending on the organisation's policy.

### Optional: Teams meeting links for events in other accounts

A Teams meeting is added to an Outlook event with the standard permissions above. To add a Teams
meeting to an event in **another** account (for example a Google Calendar event, or an event in a
second Microsoft organisation), Mail Vibes creates a stand-alone Teams meeting and puts its link
in the event. That needs one more delegated permission:

| Permission | Used for |
| --- | --- |
| `OnlineMeetings.ReadWrite` | Creating stand-alone Teams meeting links |

Add it as above and grant admin consent again. Mail Vibes asks for it only the first time
someone uses this feature ("Allow" in the event editor); nothing else changes for users who
don't use it.

### Optional: Outlook category colours

Tags on Outlook messages are Outlook categories and work with the standard permissions. To show
the categories with their Outlook colours, and to create new tags as proper Outlook categories
(with a colour, in the category list), Mail Vibes needs to read and update the mailbox settings:

| Permission | Used for |
| --- | --- |
| `MailboxSettings.ReadWrite` | Reading the category list and adding new categories |

With admin consent it is used automatically. Without it, tags still work, without colours, and
the tag dialog offers an "Allow" button.

## 3. Optional settings

- **Enterprise applications** → *Mail Vibes* → **Properties** → **Assignment required?** set to
  *Yes* limits sign-in to the users and groups you assign.
- Sign-in logs for the app are under **Enterprise applications** → *Mail Vibes* → **Sign-in logs**.

## 4. Share it with users

In Mail Vibes, **Settings → Microsoft 365 organisations → Add organisation** with the client and
tenant IDs. Then use the link button next to the organisation to copy a setup link for your
colleagues. Opening it adds the organisation after they confirm.
