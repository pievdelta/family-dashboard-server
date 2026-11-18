# Privacy Policy

*Effective November 18, 2026*

This policy covers the **Family Dashboard** app for Roku, the **Family Dashboard Server**,
and the **Chore Bounty Board** app for Android (together, "Family Dashboard").

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
computer. To build the dashboard, it contacts these services directly from your home:

| Service | Why | What it receives |
|---|---|---|
| Your calendar provider (for example Google Calendar or Outlook) | Read the calendar links you add | The private link you provided |
| Open-Meteo, OpenWeather (if you add a key), Iowa Environmental Mesonet | Weather and radar | The locations you set up |
| OpenStreetMap (map tiles and Nominatim), CARTO, OSRM | Maps, finding addresses, drive times | Map areas, event addresses, start and end points |
| AlphaPortal (only if you turn on bus tracking) | Your school bus location | Your AlphaPortal sign-in token |
| Firebase, run by Google (only if you connect it) | Chores, to-dos and settings for the phone app | Your family's chore data, in your own project |
| GitHub | Check once a day for new versions | Your network address and the server's version number |

Each service handles that information under its own privacy policy. We do not operate any of
them and do not receive what they receive.

**Chore Bounty Board app.** Stores chores, rewards, to-dos and family member names in the
Firebase project you connected to your server. Private to-dos stay with the parent who wrote
them. The app pairs with your server once on your home network and then talks directly to
your Firebase project.

## Children

Family Dashboard is meant to be set up and managed by parents. Children's names, chores and
rewards are stored only on your home computer and in your own Firebase project. We do not
collect, see or share any information about children.

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
