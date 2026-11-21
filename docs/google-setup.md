# Setting up Google sign-in

Mail Vibes needs one **OAuth client** from a Google Cloud project to access Gmail, Google Calendar,
Google Tasks and Google Contacts. It takes about 15 minutes and costs nothing.

Use a personal Google account to own the project. You don't need a credit card.

In the steps below, replace:

- `<origin>` with the address the app is served from, without a path, e.g.
  `https://yourname.github.io`
- `<app-url>` with the full app address, e.g. `https://yourname.github.io/mail-vibes/`

## 1. Create the project

1. Open <https://console.cloud.google.com/> and sign in.
2. Use the project picker at the top → **New project**. Name it e.g. `Mail Vibes`.
   Leave "Location" as "No organisation". Click **Create**, then select the new project.

## 2. Enable the APIs

Go to **APIs & Services → Library**, then search for and **Enable** each of these:

| API | Used for |
| --- | --- |
| Gmail API | Mail |
| Google Calendar API | Calendar |
| Google Tasks API | Tasks |
| People API | Contacts (recipient suggestions, "add to contacts") |
| Google Meet REST API | Creating Meet links for events in other calendars |

## 3. Configure the consent screen (Google Auth Platform)

Open **Google Auth Platform** (menu → APIs & Services → OAuth consent screen). Click
**Get started** if prompted.

1. **App information:** app name `Mail Vibes` and your email as the user support email.
2. **Audience:** choose **External**.
3. **Contact information:** your email. Accept the policy and click **Create**.

Then complete these pages from the left-hand menu:

**Branding**

- Application home page: `<app-url>`
- Application privacy policy link: `<app-url>#/privacy`
- Authorised domains: add the domain of `<origin>` (e.g. `yourname.github.io`)
- Don't upload a logo: a logo forces a brand review before the app can be used.

**Data Access** → **Add or remove scopes**. Paste these into "Manually add scopes", then
**Update** and **Save**:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/meetings.space.created
```

These are the narrowest scopes that cover the app's features:

- `gmail.modify` reads, sends, labels and moves mail to the bin. It cannot delete mail
  permanently. Google classes it as **restricted**.
- `calendar.events` creates and edits events, without access to calendar sharing settings.
  `calendar.calendarlist.readonly` only lists your calendars.
- `tasks` reads and edits your task lists.
- `contacts` reads your contacts and adds new ones.
- `meetings.space.created` creates Meet links. It can only manage the meetings the app creates.

Everything except `openid`, email and profile is classed as **sensitive** or **restricted**,
which is what triggers the limits described in step 4.

**Audience** → **Test users** → **Add users**: add every Google account that will use the app,
up to 100. Yours comes first.

## 4. Testing or In production?

The Audience page shows the **publishing status**. You have two choices:

| | **Testing** (recommended to start) | **In production**, not verified |
| --- | --- | --- |
| Who can sign in | Only the test users you listed (max 100) | Any Google account |
| Warning screen | "Google hasn't verified this app" (click *Continue*) | Same warning (*Advanced → Go to Mail Vibes (unsafe)*) |
| How long the permission lasts | **7 days**: then each user approves the app again | Until the user revokes it |
| User limit | 100 test users | **100 users in total, for the app's lifetime** |

**Effect on Mail Vibes:** the app runs entirely in the browser, so Google only gives it
short-lived access tokens (1 hour). It never receives a long-lived "refresh token". When a token
expires, the app shows a **Reconnect** prompt for that account, and one click renews it if you
are still signed in to Google in the browser.

In Testing mode you also see the consent screen again once a week. Removing the warning and the
100-user cap requires Google's **verification** of the app. That means a written justification
for each scope and a demo video, and for Gmail's restricted scope possibly a security
assessment. It's only worth doing if many people will use the app.

## 5. Create the OAuth client

**Clients → Create client**:

- Application type: **Web application**
- Name: `Mail Vibes web`
- **Authorised JavaScript origins:**
  - `http://localhost:5173` (development)
  - `<origin>`
- **Authorised redirect URIs:**
  - `http://localhost:5173`
  - `<app-url>`

Click **Create**. Copy the **Client ID**, which looks like `1234…apps.googleusercontent.com`.

- The client ID is not a secret: every user's browser sees it.
- Google also shows a **client secret**. Mail Vibes doesn't use it. Don't put it in the app or
  share it.

## 6. Give the client ID to the app

- **Local development:** add it to `.env.local` (git-ignored):
  `VITE_GOOGLE_CLIENT_ID=1234…apps.googleusercontent.com`
- **GitHub Pages:** in the repository, open **Settings → Secrets and variables → Actions →
  Variables**. Add a repository variable named `VITE_GOOGLE_CLIENT_ID` with the client ID.
  The deploy workflow passes it to the build.
