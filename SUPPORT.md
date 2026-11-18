# Getting help

**Family Dashboard** shows your family's calendar, weather, chores and school bus on your
Roku. It needs the free Family Dashboard Server running on a computer in your home.

## Setting up

1. Install the server: download the Mac installer from the
   [latest release](https://github.com/pievdelta/family-dashboard-server/releases/latest),
   or see the [README](README.md) to run it on any computer with Node.js.
2. Follow the setup page that opens in your browser (`http://localhost:3000/setup`).
3. Open Family Dashboard on your Roku. It finds the server on your home network by itself.

Just want to look around? On the Roku app's welcome screen, press **OK** to try it with demo data.

## Common problems

**The Roku can't find the server.** Make sure the computer running the server is on and on
the same Wi-Fi network as the TV. On the Roku, press **\*** and choose **Home server address**,
then type the address shown on the server's setup page (for example `192.168.1.20`).

**Phones can't pair.** The phone must be on your home Wi-Fi. Open the setup page's address in
the phone's browser: if it doesn't load, check the computer's firewall (on a Mac the setup page
shows a warning and the fix).

**Something else.** On the server's setup page, choose **Show the server log**, then
[open an issue](https://github.com/pievdelta/family-dashboard-server/issues/new) describing what
happened. Please remove calendar links, keys and addresses from anything you paste.

## Privacy

See the [Privacy Policy](PRIVACY.md).
