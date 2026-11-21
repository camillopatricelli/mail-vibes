# Place suggestions in event locations (Google Maps key)

With a Google Maps key, the **Location** field of an event suggests places as you type, as Google
Calendar does. Without a key, the field still works as plain text.

The key is your own: Mail Vibes stores it only in your browser (it's also in a settings file you
export). It is never sent anywhere but to Google Maps.

**Costs.** Google requires a billing account (a card) for Maps keys. Each month includes a free
allowance of place searches that personal use stays well within. To be sure you never pay, set a
daily limit (step 4).

In the steps below, replace `<origin>` with the address the app is served from, without a path,
e.g. `https://yourname.github.io`.

## 1. Pick a project and turn on billing

1. Open <https://console.cloud.google.com/>. You can use the same project as for Google sign-in
   ([google-setup.md](google-setup.md)).
2. Go to **Billing** and link a billing account to the project (create one if asked).

## 2. Enable the APIs

Go to **APIs & Services → Library**, then search for and **Enable** both:

- **Maps JavaScript API**
- **Places API (New)**

## 3. Create the key and restrict it

1. Go to **APIs & Services → Credentials → Create credentials → API key**.
2. Open the new key (**Edit API key**):
   - **Name:** e.g. `Mail Vibes places`
   - **Application restrictions → Websites**, add:
     - `<origin>/*`
     - `http://localhost:5173/*` (only if you run the app locally)
   - **API restrictions → Restrict key**, tick **Maps JavaScript API** and **Places API (New)**.
3. **Save**, then copy the key (it starts with `AIza`).

The website restriction means the key only works from your copy of the app, so it doesn't matter
that a browser can see it.

## 4. Set a daily limit (optional, recommended)

Go to **APIs & Services → Places API (New) → Quotas & system limits**, find
**Autocomplete requests per day** and set it to e.g. `300`.

## 5. Paste it in Mail Vibes

**Settings → Calendar → Google Maps key**, paste the key and click outside the field. Open a new
event and type in **Location**: suggestions appear after three letters.

If an error shows under the field instead, check that both APIs are enabled, billing is linked, and
the website in the key's restrictions matches the app's address exactly. Changes to a key can take
a few minutes to apply.
