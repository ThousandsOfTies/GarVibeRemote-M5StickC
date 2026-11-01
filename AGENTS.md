# GarVibeRemote-M5StickC

This Product targets M5StickC Plus2 only. The original StickC / Plus and T-Watch
are not compatible bindings. Work on the Web simulator first; do not flash a board
or configure Bluetooth/hooks unless requested.

For simulator work first read `sources/gar-tools/AGENTS.md`,
`sources/gar-tools/web-simulator/DESIGN_PRINCIPLES.md` and its `README.md`.
Inventory the shared components before adding panel controls. Keep the visible
StickC case, physical buttons and LCD boundary; this LCD has no touch input.

Reusable parts belong to gar-tools Web Components. Actual screens and button
logic belong to gar-vibe-remote/compact-ui C++/LVGL. The shared gar-vibe-remote/device-app DeviceApplication owns portable
protocol, ownership, pairing and UI integration for both firmware and PC. Product
scenarios and the synthetic JSONL peer live in simulation/host-controller.cjs;
simulation/adapter.mjs only wires public component events and HTTP pixels. Never access shared
component Shadow DOM from the Product adapter.

Commit and push shared repository changes first, then pin their commits here.
Never commit tokens, local settings, generated WASM or dependency/build caches.
Keep HTTP serving separate from build, device transports and AI-client setup.

PC setup lives in scripts/setup_remote.py and scripts/remote_config.py; see
docs/INSTALL.md, docs/DEVICE_CONNECTION.md and skills/stickc-setup/SKILL.md. Firmware lives in
firmware/stickc-plus2 and reuses CompactUi unchanged. Device transports are USB
and Bluetooth Classic SPP; Wi-Fi/LAN device support has been removed. Do not
restore Wi-Fi firmware, mDNS, LAN listeners or the former Local Bridge.
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
codex_app_client.cjs and the version-specific native_chat_reply.cjs coordination IPC.
App Tools is read-only; ordinary replies use steer/start with their original card
identities, after checking the native owner and current card. Never fall back to
delegated messages, tool output or UI automation for card completion.
Services must not import their CLI dispatcher or start
processes on import. See docs/DEVICE_CONNECTION.md. Do not synthesize human answers, forward
tool approvals, replay uncertain deliveries or automate the Codex desktop UI.
Keep roster order/membership stable at capacity; a background update must not
reset another session's reading position or focused option. Use a stable display
budget per card and preserve the device's 16-session / 64 KiB JSONL limits.
CompactUi owns priority-based automatic selection (waiting > failed > running >
idle/done), including button/list/answer guards and short feedback holds. Keep
selection display-only; never generate an answer while automatically switching.
Its rollout/App Tools compatibility is version-specific; free text and synchronous
request_user_input stay on the PC. It changes no hook definitions or trust records.
PC loopback test replies are synthetic and never user approval.
Do not import the old Copilot monitor or old hardware/interactive settings.
GAR target integration is documented in docs/GAR.md. scripts/product-target-build.sh
is the Linux build hook; scripts/gar_target_artifact.py exports the fixed Plus2
flash bundle to artifacts/from-codespace. GAR owns immutable TARGET_APP snapshots
and deploys those exact binaries through esp32_esptool; deploy must not rebuild.
Keep Linux build caches separate from the Windows firmware/connection runtimes.
GAR simulation uses host_process (Node/WASM, no VM); see docs/SIMULATION.md.
Build runs in Docker; deploy/start use checksum-verified SIM_APP snapshots. The
browser must never inject state directly into a separate UI-only application.
Keep simulation/runtime generated app and simulation/ui-runtime unit-test app
distinct; only the shared DeviceApplication runtime is packaged. Runtime input
uses explicit-length byte buffers, a single clock and the same 48KiB LVGL heap
as firmware. No simulated action may reach a native chat answer service.
GAR deploy only flashes firmware; Codex enrollment, hooks and SPP relay stay in
Product setup. ESP32 preflight/status/diag do not prove model or app health.
Porting setup code does not authorize rewriting active hooks or restarting the
user's running services. The explicit hooks command preserves unrelated entries;
only --replace-product removes the named old sender. Hook trust is a user action.


# Product composition

Read docs/COMPOSITION.md and product.json. Pin application, tools and board as
independent submodules. The board owns its verified built-in resources, driver
versions and Arduino hardware adapter; the shared application owns DeviceApplication,
DeviceLink, PairingConsent and CompactUi. Do not copy them into firmware/.
Product main.cpp connects callbacks; components.cpp includes the generated source
list once. Product owns the application identity, display use/options, PC setup,
Codex integration, scenarios and GAR artifact hooks.

hardware/binding.json selects resource names only. Pin numbers and LCD dimensions
belong to the board profile. Generate PlatformIO settings/constants with
python tools/product.py prepare (normal build hooks do this automatically).
Never hand-edit .gar/composition/ or add generated data to Git. Windows and Linux
headers are separate so parallel builds do not mix absolute paths.
Do not flash, restart a real relay, change enrollment or rewrite hooks as part
of an offline composition refactor. Verify firmware and the shared-app simulator.
