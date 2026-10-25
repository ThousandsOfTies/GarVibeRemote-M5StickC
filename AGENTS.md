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
