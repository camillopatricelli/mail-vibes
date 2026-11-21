# Mail Vibes

A browser-only, open-source client that brings several Google accounts and Microsoft 365 tenants
together in one place — Mail, Calendar and Tasks — with a Material 3 look.

> **Status:** early development. Mail, calendar and tasks work for Google and Microsoft 365
> accounts; a full guide and final polish are still to come.

## No warranty, no responsibility for your data

Mail Vibes is a personal, free, open-source project provided as is, without warranty of any kind
(see [LICENSE](LICENSE)). It has no server: your mail, events, tasks and contacts go directly
between your browser and Google or Microsoft, and are never sent to or seen by the author. You use
it at your own risk and are responsible for your accounts, your data and your organisation's
policies. If your organisation uses it, its administrators decide whether to allow it.

## Design in one paragraph

There is no backend. The app is a static single-page app (hosted on GitHub Pages); your browser
talks directly to the Gmail / Google Calendar / Google Tasks APIs and Microsoft Graph. Mail, events
and tasks are kept in memory only and never stored on the device. Only small settings (account
colours, preferences, default accounts) and the sign-in libraries' token caches are saved locally.

## Using it on several devices

Settings live in each browser; move them with a settings file and sign in again. See
[docs/other-devices.md](docs/other-devices.md).

## Microsoft 365 organisations

The app ships with no organisations built in. Each Microsoft 365 organisation needs its own
Microsoft Entra app registration (single-page application): see
[docs/microsoft-setup.md](docs/microsoft-setup.md). Its administrator can share it with users in
one of three ways:

- **Setup link:** in Settings → Microsoft 365 organisations, the link button copies a URL such as
  `https://<host>/mail-vibes/#/setup/org/<code>`. Opening it asks the user to confirm adding the
  organisation.
- **Settings file:** Settings → Back up settings → Export, then the user imports the file.
- **Manually:** Settings → Add organisation (name, application/client ID, directory/tenant ID).

These contain only public identifiers (no secrets). Self-hosters can also build organisations in
with the `VITE_MS_TENANTS` environment variable. See [.env.example](.env.example).

## Google accounts

See [docs/google-setup.md](docs/google-setup.md) for creating the Google Cloud project and OAuth
client, and the trade-offs of "Testing" vs "In production".

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

For local development, copy `.env.example` to `.env.local` (git-ignored) and fill in your own
app registrations.

On Windows, run commands from a path with an upper-case drive letter (`C:\...`); Vitest fails to
start from `c:\...`.

A full README (trade-offs, self-hosting with your own app registrations) will come in a later phase.

## Licence

MIT. Icons are Material Symbols (Apache-2.0). Roboto font (Apache-2.0 / OFL) via Fontsource.
