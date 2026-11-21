# Family Dashboard Server

The home server behind the **Family Dashboard** Roku app and the **Chore Bounty Board**
Android app. It gathers your family calendar, weather, travel times, the school bus and
chores, and hands them to the TV. Your data stays on your computer and in a Firebase
project that belongs to you.

## Install on a Mac (easiest)

1. Download **Family-Dashboard-Server-x.y.z.pkg** from the
   [latest release](../../releases/latest) and open it.
   - The installer isn't signed with an Apple Developer ID yet, so macOS may say it
     "can't be verified". Open **System Settings > Privacy & Security**, scroll down
     and choose **Open Anyway**, or right-click the file and choose **Open**.
2. When it finishes, your browser opens the setup page
   (`http://localhost:3000/setup`). It walks you through connecting Firebase and
   pairing phones.
3. Open the Family Dashboard on your Roku. It finds the server by itself.

The installer brings its own copy of Node, runs the server in the background whenever
you're logged in, and restarts it if it ever stops. It needs macOS 13.5 or newer and
works on Intel and Apple silicon Macs.

| What | Where |
|---|---|
| Your settings, keys and log | `~/Library/Application Support/Family Dashboard/Settings` |
| The program | `~/Library/Application Support/Family Dashboard` |
| Remove it | Double-click **Uninstall Family Dashboard** in that folder |

For a Mac that lives by the TV, turn on automatic login so the server comes back
after a power cut.

## Web dashboard

Open `http://<server address>:3000/` in any browser on your home network: a tablet on
the wall, a laptop, or a phone. It shows the same Today, calendar, weather, travel and
chores screens as the TV, and kids can tap a chore to check it off. On a tablet, use
**Add to Home Screen** so it opens full screen, and turn off auto-lock to keep it on.

## The TV page (any smart TV)

Open `http://<server address>:3000/tv` in a TV's web browser, or in a small TV app that
opens it, for a screen made for a remote: a Home screen of cards, and OK on a card opens
its section (calendar, weather, travel, chores, lists, Home Assistant). The arrows move,
Back goes back. It is drawn at 1920 x 1080 and scaled to fit, so nothing scrolls off the
screen, and it runs on LG webOS and Samsung Tizen TVs from about 2019 on, as well as
Android TV and Fire TV. Add `?demo=1` to see a made-up family.

**Each TV gets its own layout.** A TV that opens the page shows up on the setup page under
**TVs**. Name it ("Kitchen", "Bedroom") and pick a layout: **Whole house**, **Parents**
(to-dos, groceries, meals, no chores), **Kids** (chores, the bus, no to-dos) or your own,
with the cards and sections you choose. A layout can also show one parent's private to-dos,
for the TV in your bedroom. The Roku app uses the same layouts from version 4.5. The list
of TVs is kept in `tvs.json`.

## AI features (optional)

Add your own key from Google AI Studio (Gemini, with a free tier), Anthropic (Claude) or
OpenAI on the setup page, under **AI**. The phone app then offers **Meal ideas** on the
grocery list and meal plan (using your pantry staples and what you just bought) and a
**Brain dump** on its Today screen. Requests go from your server straight to the company
you chose; nothing is saved until you confirm it.

## Home Assistant (optional)

If your home runs Home Assistant, open the setup page's **Home Assistant** section, paste its
address (like `http://homeassistant.local:8123`) and a long-lived access token (in Home
Assistant: your profile, **Security** tab, **Create token**). Then pick what the TV shows and
which devices alert the family: the doorbell, a garage left open, a leak. It only reads; it
never controls anything. The token stays in `config.txt`; your picks are in `home-assistant.json`.

## Android TV

The Family Dashboard Android app also runs on Android TV. On the TV it finds this server
on your Wi-Fi by itself, like the Roku app, and shows the web dashboard full screen.

## Updates

The server checks GitHub once a day. When a new version is out, the setup page shows
**Update to x.y.z** with what changed. One click downloads it, checks it against the
release's checksums, and restarts into it. Your settings, keys and paired devices
aren't touched. If the new version doesn't start, the server goes back to the version
you had and says so on the setup page.

## Run it yourself (any computer)

1. Install Node 22 or newer.
2. `git clone` this repository (or download the source zip), then `npm install`.
3. Copy `config.example.txt` to `config.txt`. You can leave the rest empty: the
   setup page and the app fill in most settings.
4. `npm start`, then open `http://<this computer>:3000/setup`.

A copy run this way tells you on the setup page when a new version is out; update it
with `git pull && npm install` and start it again.

### Moving from a hand-run copy to the installer

Stop the old copy (close its Terminal window), run the installer, then copy these
files from the old folder into the new **Settings** folder (the setup page has a
**Show settings folder** button) and restart the server from the setup page or by
logging out and back in:

`config.txt`, `household.json`, your `...firebase-adminsdk...json` key,
`firebase-app.json`, `.cloud-sync.json`, `calendar-filters.json`

## How events find their person

For each event the server checks, in this order:

1. A calendar feed that belongs to one person. Give that person `"sourceType": "work"`
   and every event from `WORK_ICAL_URL` is theirs.
2. A person's `locationRules` (words in the title and the place together).
3. `matchKeywords` for a parent.
4. `calendars.sharedEventKeywords` (for example "no school"): all the kids.
5. `matchKeywords` for one or more kids.
6. Anything else is a whole-family event.

Keywords match whole words, so "hold" hides "Hold for dentist" but not "Household budget".

## Chores app and Firebase

Chores, rewards, to-dos and the dashboard settings live in a free Firebase
project that belongs to you, so the Chore Bounty Board app works away from home.
The setup page walks through it:

1. Create a Firebase project, then a Firestore database, then choose
   **Authentication > Get started**.
2. Save the project's service-account key (Project settings > Service accounts >
   Generate new private key) next to `server.js`, and restart.
3. The setup page finds or registers the app's connection details, shows a
   pairing code and QR code, and publishes the security rules when you press
   the button (do that once your phones are on app 2.1).

Each phone or tablet pairs once on the home Wi-Fi, then works anywhere. Remove
a lost phone from the setup page or from the app.

What the app can change from anywhere: everything in `household.json`, and the
calendar links, weather key and bus token in `config.txt` (the app can replace
those but never read them back). Changes are applied by a quick restart.

Chores with a due date, chores that repeat at a set time ("Mon-Fri 7:15 AM"),
and parent to-dos with a due date appear on the TV's calendar. Private to-dos
never leave the phone of the parent who wrote them.

## On the TV (app 4.3)

- **Big map.** On Today, move to the travel tile and press OK (or press OK on
  the Travel screen). The map fills the screen with the bus, home and the next
  stop. UP / DOWN zoom, OK fits everyone again, LEFT / RIGHT switch person.
  It refreshes every 15 seconds while open.
- **Check off chores.** On the Chores screen press OK, pick the chore, press OK.
  If nobody is selected and the chore isn't assigned, the TV asks who did it.
  It works like the app: a parent approves it in the app, unless the household
  is set to skip approval. This only works from your home network.
- **Finding the server.** The server answers TVs looking for it on the home
  network (SSDP on UDP port 1900). If the log says discovery is off, the TV
  still works with a typed-in address.

## Alerts (sounds on the TV)

The `notifications` block in `household.json` decides what the TV chimes for:

```json
"notifications": {
  "eventLeadMinutes": 5,
  "leaveAlerts": true,
  "busNearFeet": 2000,
  "quietStart": "21:30",
  "quietEnd": "06:30"
}
```

- `eventLeadMinutes`: chime this many minutes before each timed event (0 turns it off).
- `leaveAlerts`: chime at the "leave by" time for events that have an address.
- `busNearFeet`: chime once per run when the bus gets this close to home (0 turns it off).
- Between `quietStart` and `quietEnd` the banner still shows but no sound plays.

Each TV can also turn sounds off under `*` > Alert sounds.

## Live school bus (AlphaPortal)

1. Sign in at your district's AlphaPortal site (for example https://yourdistrict.alphaportal.app).
2. Open the browser's developer console and run
   `JSON.parse(localStorage.user).User.RefreshToken`
3. Paste the result into `config.txt` as `ALPHAPORTAL_REFRESH_TOKEN=...` and restart.

The token lasts 8 days, and the tracker renews it on its own as long as the
server keeps running. If the server was off for more than 8 days, capture a new one.

The server finds your children's AlphaPortal ids itself. When it starts it prints
`[AlphaPortal] Tracking ...` or the reason it can't. For a live check, open
http://localhost:3000/api/bus/status on the server computer.

The bus shows whenever AlphaPortal reports a position, at any hour, for anyone
in `household.json` with `"hasBus": true` who is set to ride the bus that day.

## Keep private

`config.txt`, `household.json`, `firebase-app.json`, `home-assistant.json`, `tvs.json` and the Firebase key file hold
your secrets and your address. They are listed in `.gitignore`. Leave them out of anything you share.

The server has no password. Run it only on your home network and do not
forward its port to the internet.

## Making a release (maintainers)

1. Update `version` in `package.json` and add a `## x.y.z` section to `CHANGELOG.md`.
2. Commit, then `git tag vx.y.z && git push --tags`.
3. The **Release** workflow tests the server, builds the update bundle and the Mac
   installer, and publishes them with a `SHA256SUMS` file. Installed servers see it
   within a day.

To sign and notarize the installer later, add `PKG_SIGN_IDENTITY` and
`NOTARY_PROFILE` secrets to the repository and set up the signing certificate on the
build machine (see `installer/macos/build-pkg.sh`).

## Help and privacy

- [Getting help](SUPPORT.md)
- [Privacy Policy](PRIVACY.md)

## License

Copyright (C) 2026 Kevin Loux

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.
It comes with no warranty. See [LICENSE](LICENSE).

If you run a modified version for other people to use over a network, the AGPL
asks you to offer them its source code too.
