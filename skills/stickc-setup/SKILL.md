---
name: stickc-setup
description: Set up or reconnect GarVibeRemote-M5StickC on Windows, including Plus2 firmware, Bluetooth Classic SPP or USB, the PC status bridge and monitoring hooks. Use for installation, migration or OFFLINE diagnosis. BLE is not implemented.
---

# StickC setup

Find the Product from `references/installation.json` beside this installed skill.
In the repository source copy, it is two directories above this folder.
Read `docs/INSTALL.md` there for commands and the current completion criteria.

Start with `python scripts/setup_remote.py doctor` from the Product root.
It is read-only; report PC readiness separately from physical device readiness.
The default simulator uses local mock data. For simultaneous live viewing,
run `simulator-feed` separately from static HTTP and open `?live=1` on the panel.
The feed is read-only, validates the local page origin and keeps tokens on the PC.
SPP/USB firmware shares its real LVGL UI.
The existing Codex bridge sends one selected (or latest observed) session;
automatic live multi-session collection and BLE are not implemented.
Do not flash the old shared M5StickC client as this portrait UI.

For an explicit installation request, read `firmware/stickc-plus2/README.md`.
Confirm the model is Plus2, using existing user confirmation when available;
a CH9102 USB port alone does not identify the model. Use `scripts/firmware.py`
to build, identify the USB device, save an 8MB flash backup and flash it.
The installation request authorizes this replacement; no extra permission is
needed once the target is known. Test the display, orientation and A/B/C with
`scripts/serial_demo.py` using `.gar/firmware-tools` Python (includes pyserial).
Only a received physical button response proves device input. Synthetic sessions
are connection tests, not user permission for files, tools or other operations.

For pairing, COM selection and relay operation read `docs/DEVICE_CONNECTION.md`.
The device is `GarVibe-M5StickC-Plus2`. Pair by comparing the six-digit numbers
on Windows and Plus2, then C to select YES and A to confirm on the device, and
confirm on Windows. Fixed PIN 1234 belongs to the previous firmware. A pairing
request expires after 30 seconds; never auto-accept a number. Stop an active USB
relay before pairing (a read-only USB snapshot is safe). Read `pairingMode`,
`pairingState` and `lastAuthentication` for diagnosis without logging passkeys.
Use its Windows
outgoing COM port, never a remembered T-Watch COM number. `device-test --port
COM_NUMBER --transport spp` runs an isolated physical trial; `device` uses the
saved PC config. The relay keeps the PC token off the device. USB is a fallback;
only one transport owns the UI, and a USB snapshot does not take ownership.
Do not replay unanswered actions after a connection loss. Long-press approval
requests stay on the PC because this UI confirms with a short A release.

Use `prepare` for the isolated Node runtime and `configure --project PATH`
for private settings. Retain existing tokens and session selections. To migrate
settings use `--import-config OLD_CONFIG`; it imports only PC facts and drops
old hardware ports and interactive approval settings. Never print secrets.

`hooks --project PATH` writes monitoring hooks. `--replace-product OLD_PRODUCT`
explicitly replaces that Product's sender while preserving unrelated hooks.
The user reviews changed definitions in Codex; do not edit trust records.
An installation request authorizes the needed setup steps, but porting the
implementation alone does not authorize rewriting the user's running setup.

`bridge` starts only the PC bridge. Check for a process on the configured port
before starting another; do not stop an existing service merely to free its port.
`test` starts an ephemeral PC-only bridge and synthetic client. Its success proves
HTTP/authentication, metadata delivery and question/answer round trips inside
the PC. It is never a real user's YES/NO or permission for another action.

Keep static HTTP serving, bridge operation and setup separate. Preserve the
current work when diagnosing an unavailable connection. Do not configure
Copilot or other AI clients. Pairing and relay operation require the user's
device-connection request; PC preparation alone does not authorize them.
