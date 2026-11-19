# Changelog

## 5.6.0

- AI with your own key (optional): Gemini, Claude or OpenAI. Add it on the setup page or in the app's TV settings. An existing `GEMINI_API_KEY` line in config.txt is used automatically.
- **Meal ideas** (app 2.4): four dinner ideas from what your kids will eat and what's on the grocery list, with the missing ingredients one tap from the list.
- **Brain dump** (app 2.4): type everything on your mind; it comes back sorted into to-dos, groceries and events for you to check before anything is saved.
- Requests go through your family's Firebase, so they work from anywhere. At most 30 an hour, and old ones are cleaned up after a day.
- The setup page can test the key, and the app's server status shows whether AI is working.

## 5.5.0

- The family schedule for the next 7 days is shared with the app (Family Dashboard 2.3), so parents see today and tomorrow on their phone anywhere, not just at home. Updated only when something changes.
- Web dashboard: chores and bounties are shown separately. Bounties are open to any kid, first one done earns it; chores belong to one kid.

## 5.4.0

- New web dashboard: open the server's address (for example http://192.168.1.20:3000) in any browser on your home network. Today, calendar (agenda, week, month), weather with radar, travel with the full-screen bus map, and chores you can check off by tapping.
- Works on wall tablets, laptops and phones, in dark or light, and can be added to a tablet's home screen to open full screen.
- Browsing a person or a city on the web doesn't change what the TV shows.
- Optional alert chimes and a return to Today after a few quiet minutes, for a screen on the wall.

## 5.3.0

- Works with the renamed Android app, Family Dashboard 2.2 (app id `io.loux.familydashboard`). Phones on the old Chore Bounty Board app keep working.
- One color per person: a chore profile linked to a person on the TV uses that person's color everywhere, and the app can make the link explicitly.
- The app shows how the server is doing: running, calendar loaded, bus tracker connected, update available. The server reports every 5 minutes.

## 5.2.1

- The Mac installer now lets phones and the TV through the macOS firewall. Before, a background server never got the "allow incoming connections?" question, so pairing couldn't reach it.
- The setup page warns when the firewall is blocking the server and shows how to fix it.
- The setup page says plainly that the server is running in the background, with nothing to keep open.
- Moving from a copy you ran with npm start: choose its config.txt, household.json and other settings files on the setup page and the server brings them in.

## 5.2.0

- New Mac installer: brings its own Node, runs in the background at login, and opens the setup page when it's done.
- One-click updates from the setup page. Downloads are checked against the release's checksums, and a version that won't start is rolled back automatically.
- Connect Firebase by choosing the key file on the setup page. No need to find the server's folder.
- The setup page can show the server log, open the settings folder, and restart the server.
- A clear message when port 3000 is already taken by another copy of the server.

## 5.1.0

- Full-screen map for the TV (bus, home and the next stop), for Roku app 4.3.
- Check off chores from the TV.
- TVs find the server on the home network by themselves.
- Quieter calendar log.

## 5.0.0

- Your own Firebase: pairing phones with a code or QR, app settings synced both ways, keys sent from the app.
- Chores with due dates and routines on the TV calendar; private parent to-dos.
