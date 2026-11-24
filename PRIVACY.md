# Privacy Policy

*Effective November 24, 2026*

This policy covers the **Family Dashboard** app for Roku, the **Family Dashboard Server**,
and the **Family Dashboard** app for Android and Android TV (first released as Chore Bounty Board) (together, "Family Dashboard").

## The short version

Family Dashboard is built so that **we never receive your family's information.** There are
no accounts with us, no ads, no analytics and no tracking. Your calendar, chores and settings
stay on a computer in your home and in a Firebase project that **you** create and own.

## What each part stores, and where

**Roku app.** Remembers its settings on the Roku device: your home server's address, whether
demo data is on, and your sound and screen preferences. It talks only to the Family Dashboard
Server on your home network and loads the map and weather images that server provides. It
does not send anything to us or to anyone else.

**Family Dashboard Server.** Runs on a computer you own. It keeps your settings (family
members' names and colors, places, calendar links and keys you enter) in files on that
computer, along with the TVs that have opened the dashboard (a random ID, model name, the
name you give each TV, and when it was last on). To build the dashboard, it contacts these services directly from your home:

| Service | Why | What it receives |
|---|---|---|
| Your calendar provider (for example Google Calendar or Outlook) | Read the calendar links you add | The private link you provided |
| Open-Meteo, OpenWeather (if you add a key), Iowa Environmental Mesonet | Weather and radar | The locations you set up |
| OpenStreetMap (map tiles and Nominatim), CARTO, OSRM | Maps, finding addresses, drive times | Map areas, event addresses, start and end points |
| AlphaPortal (only if you turn on bus tracking) | Your school bus location | Your AlphaPortal sign-in token |
| Firebase, run by Google (only if you connect it) | Chores, to-dos and settings for the phone app | Your family's chore data, in your own project |
| Your Home Assistant (only if you connect it) | Show the devices you pick and alert you about them | Your Home Assistant token; it stays on your home network |
| GitHub | Check once a day for new versions | Your network address and the server's version number |
| The AI company you choose: Google (Gemini), Anthropic (Claude) or OpenAI (only if you add your own key) | Meal ideas and sorting a brain dump, only when you ask | What you type, family first names, the foods and interests you entered for your kids, food allergies you entered for anyone in the family, the grocery list, pantry staples and planned meals |

Each service handles that information under its own privacy policy. We do not operate any of
them and do not receive what they receive.

**Android app.** Stores chores, rewards, to-dos, the grocery list, pantry staples, the meal plan, family member names and any food allergies you enter in the
Firebase project you connected to your server. Private to-dos stay with the parent who wrote
them. The app pairs with your server once on your home network and then talks directly to
your Firebase project. It also keeps the names and layouts you give your TVs there.

The camera is used only to scan the pairing QR code on your server's setup page; no picture
is saved or sent anywhere. The app works without the camera if you type the code instead.

Another app on the same phone (for example AllergyCompass) can ask for your family's food
allergies. Nothing is shared unless a parent approves that request on the phone, and then only
the names and allergies the parent picks go to that app, on the device, never to us.

On an Android TV or Fire TV, the app doesn't pair or sign in: like the Roku app, it finds the
server on your home network and shows its dashboard. It gives the server a random ID for the
TV and the TV's model name, so a parent can name the TV and choose what it shows.

## AI features

AI features are off unless you add your own key from Google, Anthropic or OpenAI on the
server's setup page. When you tap **Meal ideas** or **Sort it out**, your server sends the
details listed above directly to the company you chose, using your key, and shows you the
answer. Nothing it suggests is saved until you confirm it. That company handles the request
under its own terms and privacy policy for your account.

## Children

Family Dashboard is meant to be set up and managed by parents. Children's names, chores and
rewards are stored only on your home computer and in your own Firebase project. We do not
collect, see or share any information about children. If a parent turns on AI features and
asks for meal ideas, kids' first names and the foods, interests and allergies the parent entered go to
the AI company the parent chose, as described above.

## Your control

Everything is yours to change or delete: edit or remove settings from the server's setup page
or the phone app, delete your Firebase project in the Firebase console, and uninstall the
apps and server at any time. Because we never receive your data, there is nothing for us to
delete.

## Changes

If this policy changes, the new version will be posted here with a new effective date.

## Contact

Questions about privacy: open an issue at
https://github.com/pievdelta/family-dashboard-server/issues
