# GarVibeRemote-M5StickC

This Product targets M5StickC Plus2 only. The original StickC / Plus and T-Watch
are not compatible bindings. Work on the Web simulator first; do not flash a board
or configure Bluetooth/hooks unless requested.

For simulator work first read `sources/gar-tools/AGENTS.md`,
`sources/gar-tools/web-simulator/DESIGN_PRINCIPLES.md` and its `README.md`.
Inventory the shared components before adding panel controls. Keep the visible
StickC case, physical buttons and LCD boundary; this LCD has no touch input.

Reusable parts belong to gar-tools Web Components. Actual screens and button
logic belong to gar-vibe-ui/compact-ui C++/LVGL. Product scenarios, protocol
mapping and connections belong to simulation/adapter.mjs. Never access shared
component Shadow DOM from the Product adapter.

Commit and push shared repository changes first, then pin their commits here.
Never commit tokens, local settings, generated WASM or dependency/build caches.
Keep HTTP serving separate from build, device transports and AI-client setup.

PC setup lives in scripts/setup_remote.py and scripts/remote_config.py; see
docs/INSTALL.md, docs/DEVICE_CONNECTION.md and skills/stickc-setup/SKILL.md. Firmware lives in
firmware/stickc-plus2 and reuses CompactUi unchanged. The shared m5stickc-client
is the separate legacy Wi-Fi implementation; its handoff/button mapping and
T-Watch touch instructions do not apply to this Product. scripts/firmware.py
builds, backs up and flashes the confirmed Plus2; scripts/serial_demo.py tests physical
input over USB. scripts/device_bridge.cjs connects the existing selected-session
Codex bridge over SPP or USB; device_trial.cjs is an isolated physical test.
scripts/session_monitor.cjs collects up to 16 local Codex chats across projects,
one project or explicit ids, using App Tools. It keeps per-chat question workers,
reply allowlists and delivery journals. Ordinary physical replies must retain
session + native question + choice identities. No automatic task creation.
scripts/pc_config.cjs owns Node entry-point configuration validation;
remote_config.py validates Python setup reads and writes. device_protocol.cjs
owns pure JSONL framing/state mapping and must not import device transports.
BLE remains unimplemented. Do not confuse synthetic multi-session tests with
two independent real chats answered on the physical device.
scripts/simulator_feed.cjs is a separate read-only localhost WebSocket feed for
the ?live=1 panel. Keep private tokens out of public assets, URLs and browsers;
browser input must not become a real approval. Static serving stays separate.
scripts/chat_questions.cjs dispatches the single-chat or multi-session CLI.
native_question_log.cjs parses local history without network access;
question_service.cjs mirrors cards and delivers physical selections through
codex_app_client.cjs. Services must not import their CLI dispatcher or start
processes on import. See docs/DEVICE_CONNECTION.md. Do not synthesize human answers, forward
tool approvals, replay uncertain deliveries or automate the Codex desktop UI.
Keep roster order/membership stable at capacity; a background update must not
reset another session's reading position or focused option. Use a stable display
budget per card and preserve the device's 16-session / 64 KiB JSONL limits.
Its rollout/App Tools compatibility is version-specific; free text and synchronous
request_user_input stay on the PC. It changes no hook definitions or trust records.
PC loopback test replies are synthetic and never user approval.
Do not import the old Copilot monitor or old hardware/interactive settings.
Porting setup code does not authorize rewriting active hooks or restarting the
user's running services. The explicit hooks command preserves unrelated entries;
only --replace-product removes the named old sender. Hook trust is a user action.
