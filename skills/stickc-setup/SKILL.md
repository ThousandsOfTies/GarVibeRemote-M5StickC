---
name: stickc-setup
description: Set up or diagnose GarVibeRemote-M5StickC for M5StickC Plus2 on Windows, including PC settings, Codex hooks, the status bridge and USB test firmware. Use for installation or migration; BLE and live Codex-to-device integration are not yet implemented.
---

# StickC setup

Find the Product from `references/installation.json` beside this installed skill.
In the repository source copy, it is two directories above this folder.
Read `docs/INSTALL.md` there for commands and the current completion criteria.

Start with `python scripts/setup_remote.py doctor` from the Product root.
It is read-only; report PC readiness separately from physical device readiness.
The simulator uses local mock data. USB test firmware shares its real LVGL UI,
but BLE transport and live multi-session Codex bridge integration are not
implemented. Do not flash the old shared M5StickC client as this new UI.

For an explicit installation request, read `firmware/stickc-plus2/README.md`.
Confirm the model is Plus2, using existing user confirmation when available;
a CH9102 USB port alone does not identify the model. Use `scripts/firmware.py`
to build, identify the USB device, save an 8MB flash backup and flash it.
The installation request authorizes this replacement; no extra permission is
needed once the target is known. Test the display, orientation and A/B/C with
`scripts/serial_demo.py` using `.gar/firmware-tools` Python (includes pyserial).
Only a received physical button response proves USB input. Synthetic sessions
are connection tests, not user permission for files, tools or other operations.

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
Copilot or other AI clients, Bluetooth pairing or relay services as part of
the PC or USB test setup.
