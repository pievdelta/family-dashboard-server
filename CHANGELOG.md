# Changelog

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
