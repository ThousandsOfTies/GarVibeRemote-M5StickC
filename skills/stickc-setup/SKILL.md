---
name: stickc-setup
description: Prepare or diagnose the Windows PC side of GarVibeRemote-M5StickC for M5StickC Plus2, including private settings, Codex hooks and the local status bridge. Use for installation or migration of its setup tools; physical BLE and firmware are not yet implemented.
---

# StickC setup

Find the Product from `references/installation.json` beside this installed skill.
In the repository source copy, it is two directories above this folder.
Read `docs/INSTALL.md` there for commands and the current completion criteria.

Start with `python scripts/setup_remote.py doctor` from the Product root.
It is read-only; report PC readiness separately from physical device readiness.
The current simulator uses local mock data, and the new firmware/BLE transport
and live multi-session bridge integration are not implemented. Do not promise
device delivery or flash the old shared M5StickC client as this new UI.

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
Copilot or other AI clients, Bluetooth pairing, relay services or firmware as
part of this PC setup skill.
