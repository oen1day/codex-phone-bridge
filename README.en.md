> In the beginning, the Emperor started with a single phone,
> summoned AI by night to plan, and thus won the realm.
> Yet the realm is not settled, nor fully united;
> the wish is not to sit alone on the throne, but that the people live in peace and prosperity.
>
> —— This is the founding aspiration of this software

© 2026 add. All rights reserved. This is a personal open-source project.

This software is released under the GPL-3.0 license. See the LICENSE file.

# 鳍点AI (Qidian AI) — DeepSeek Edition

A small tool that lets you control Codex on your PC directly from your phone, without logging into a ChatGPT account. The model still uses the DeepSeek endpoint configured on your computer — chat, send images, view results, and approve commands all happen on your phone.

## What it does

It runs a "bridge service" on your computer and connects to the Codex program already installed there. Open a web page on your phone and you can:

- Start new conversations or continue previous ones
- Send text and upload images from your phone
- Watch Codex replies, command executions, and file changes in real time
- Approve or reject privileged commands with one tap when they pop up on your phone
- Stop a running task at any time
- Have AI replies read aloud automatically or manually (requires the local "Xiaoyun" offline voice service on your PC)

All code and files run only on your own computer; nothing is uploaded to any server.

## Screenshots

The UI follows a "deep-sea dark + neon line art" style: dark blue-black background, teal single-line outlines, restrained rounded corners, and no heavy shadows.

![Main chat screen](docs/screenshots/01-chat.jpg)

**Main chat screen**: shark line-art logo and "鳍点AI" at the top, with refresh and settings on the right. Connection status is shown as a glowing dot (teal = connected) next to a reconnect button. The composer at the bottom supports text and images, with a teal "Send" button.

![Sidebar and new chat](docs/screenshots/02-sidebar.jpg)

**Sidebar**: "+ New Chat", "Claim Old Chat", and "Collapse" entries at the top; a one-click configuration key area at the bottom (new users paste the key shown in the PC window to pair automatically); the version, current mode, pairing code, and reasoning effort are shown at the bottom with live relay status.

![Connection settings](docs/screenshots/03-settings.jpg)

**Connection settings**: choose "LAN connection" (same Wi-Fi) or "Relay connection" (works over mobile data outdoors); one-click key configuration, or manual pairing code / password / update URL; reasoning effort, auto-read-aloud, and per-feature "capability switches" (e.g. device status, off by default — the AI will ask you to enable it in settings if it is not on).

## Getting started

1. Double-click `start.bat` (if it does not open, right-click `start.ps1` → Run with PowerShell).
2. The window shows two addresses:
   - On your PC: `http://localhost:8787`
   - On your phone: `http://PC-IP:8787` (phone and PC on the same Wi-Fi)
3. Open that address on your phone and enter the access password shown in the startup window (a random password is generated automatically on first run).
4. Tap "New Chat" on your phone and start using it.

Note: keep the black window open — closing it stops the service.

## Installing the APK (Android)

A ready-built APK (`CodexPhoneBridge.apk`) is included in the release package.

1. Transfer `CodexPhoneBridge.apk` to your phone (WeChat/QQ file transfer, USB cable, cloud drive, etc.).
2. Tap to install. If prompted about "unknown sources" on first install, allow it.
3. On first launch, choose a connection mode:
   - "LAN connection": use when the phone and PC share the same Wi-Fi. Enter the address shown in the startup window, e.g. `http://192.168.2.161:8787`
   - "Relay connection (mobile data)": works outdoors over mobile data. Enter the pairing code and access password shown in the startup window.
4. Save and you are ready — the app opens straight into the chat screen next time.

There are "Refresh" and "Settings" buttons at the top; settings let you change the PC address and toggle auto read-aloud for AI replies.

## Checking for updates (one-click updates)

The phone app has an "Update URL" field and a "Check update" button in settings. To make one-click updates work, put new version files at a fixed URL (a free GitHub account with Releases is recommended) and fill in the `version.json` URL at:

- Phone app settings → Update URL
- PC `config.json` → `updateUrl`

> Note: the default update URL points to the author's repository `oen1day/codex-phone-bridge`. If you fork or build your own version, change `updateUrl` in the PC `config.json` and the update URL in the phone settings to your own, otherwise it will check against the author's releases. Checking for updates is just a GET request to GitHub and does not use or affect the author's service.

`version.json` format:

```json
{
  "version": "1.3",
  "pcZip": "https://your-url/pc.zip",
  "apk": "https://your-url/phone.apk"
}
```

The PC checks for new versions on startup; the phone "Check update" button shows the result and opens the new APK download/install page.

## One-click publishing to GitHub (recommended)

The `publish-update.ps1` script is included. It creates a public repository, writes the update URL into `config.json`, builds a new PC zip, uploads `version.json`, and publishes a Release with both install packages.

Three steps:

1. Install the GitHub CLI (run in your terminal):
   `winget install --id GitHub.cli`
2. Log in once:
   `gh auth login`
3. Run the script: right-click `publish-update.ps1` → Run with PowerShell

The script reads your GitHub username from your git config (currently `oen1day`). If it is wrong, it will ask you to type it. When finished, paste the URL it prints into the phone app settings → Update URL. Note: the extracted folder already contains the phone APK; the script uploads it together with the PC zip.

## Can I use it over mobile data (outdoors)?

Yes — this version has a built-in "relay" feature:

1. Start `start.bat` on your PC as usual and note the pairing code and password in the window.
2. In the phone app, choose "Relay connection (mobile data)" and enter the pairing code and password.
3. After that the phone can reach your PC's Codex over Wi-Fi or mobile data. No public IP, no server, no Tailscale needed.

Note: relay traffic goes through a free public relay broker. Content is encrypted with your password, so others cannot read it; speed depends on the relay network.

Alternative (more stable, requires a free app): Tailscale

1. Install Tailscale on your PC (https://tailscale.com/download) and sign in.
2. Install the Tailscale app on your phone and sign in with the same account.
3. Your PC gets a `100.x.x.x` virtual address (visible in the Tailscale UI).
4. In the phone app choose "LAN connection" and enter `http://100.x.x.x:8787`.

## TTS (read-aloud) dependency

Read-aloud requires a local IndexTTS-2 offline voice service (Apache-2.0). The cloned "Xiaoyun" voice assets are not distributed with this repository. You need to deploy the voice service yourself and configure `ttsUrl` (service URL) and `ttsPythonPath` (Python interpreter path) in `config.json`. Without it, the read-aloud feature reports it is unavailable; everything else keeps working.

## Configuration

Open `config.json` in a text editor:

- `password`: access password — change it to your own (important)
- `port`: port, default 8787
- `workspace`: Codex working directory (defaults to `Documents/Codex` on first run)
- `model`: model name; leave empty to use the default model configured on your PC (DeepSeek)
- `approvalPolicy`:
  - `on-request`: ask for every privileged command (recommended)
  - `never`: run without asking (convenient but dangerous)
  - `reject`: always reject
- `sandbox`:
  - `workspace-write`: can only modify files in the working directory (recommended)
  - `danger-full-access`: can operate on the whole computer (dangerous)
  - `read-only`: read-only
- `transport`: `spawn` (default, starts Codex itself); `proxy` (connects to an already-running Codex service, for advanced users)
- `relayEnabled`: enable the built-in relay (default on, used for mobile data connections)
- `relayBroker`: relay broker address, usually leave unchanged
- `relayRoomCode`: phone pairing code, auto-generated; you can set any six alphanumeric characters

Save the file and restart `start.bat`.

## Where do I find the pairing code on my PC?

After double-clicking `start.bat`, the window shows a line "手机配对码(流量用): XXXXXX" — that is the pairing code for the phone relay connection. It is stored in `relayRoomCode` in `config.json` and can be changed to any six alphanumeric characters.

## FAQ

**The phone cannot open the web page**
Make sure the phone and PC are on the same Wi-Fi and the Windows firewall allows port 8787 (allow it when prompted on first run).

**"Codex connection failed"**
Make sure `codexPath` in `config.json` is empty (the program auto-detects it) and that a recent version of the Codex desktop app is installed.

**Why is this different from the conversations on my desktop?**
This tool creates its own conversations by default, so it does not interfere with the desktop app. It uses the same working directory and model (DeepSeek) as the desktop.

## Public version notes

- First run: if `config.json` does not exist, the program auto-generates a pairing code, a random access password, and a config key, written to `config.json` and `~/.codex/phone-bridge-id.json`; existing configs are kept as-is and never reset.
- One-click pairing for a new phone: copy the "one-click config key" from the black window, paste it into the phone app's first screen, and the pairing code/password/update URL are configured automatically.
- Release packages contain only the `config.example.json` template, never real credentials. Never commit `config.json`, `paths.json`, or `debug.keystore` to a public repository.
- Security: change your access password regularly; do not share `config.json` or keys with untrusted people.

## Contributing

Contributions of any kind are welcome: issues, bug fixes, features, and documentation.

1. Fork this repository and develop on your own `main` branch.
2. Before changing anything, run the 7 verification scripts under `tests/` (smoke-app / autospeak / paging / rebind / capabilities / crashguard / about) to make sure existing features do not regress.
3. Keep the author watermark in the source and the git commit watermark (`--by your-name`) in your commits; do not remove or alter copyright information.
4. Open a Pull Request and describe what you changed and how you verified it.

The UI is currently Chinese-only. Translations and other language contributions are welcome!

Derivative development note: if you fork and publish your own version, change `updateUrl` in the PC `config.json` and the update URL in the phone settings to your own, and comply with GPL-3.0 (distribute under the same license and keep the copyright notice).

## Copyright and License

© 2026 add. All rights reserved.

This project is released under the **GNU GPL-3.0** license. See the [LICENSE](LICENSE) file.

- You may freely use, modify, and distribute this software (including commercially);
- But if you distribute or sell it (or a modified version of it), you must **open-source it under GPL-3.0 as well** and keep the copyright and license notices;
- This software is provided "as is", without warranty of any kind, express or implied;
- Without the author's written permission, you may not remove, obscure, or modify the copyright, attribution, or source information.

## Acknowledgments

- [Codex](https://openai.com/codex/): the software this tool bridges to;
- DeepSeek: the model endpoint (uses the configuration on your own PC);
- [IndexTTS-2](https://github.com/index-tts/index-tts) (Apache-2.0): offline voice synthesis engine; the cloned "Xiaoyun" voice assets are not distributed with this repository;
- Free public MQTT relay brokers: let the phone reach the PC from outdoors.
