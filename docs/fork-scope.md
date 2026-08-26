# t3code-pi fork scope

This fork exists to make Pi a first-class T3 Code provider while staying as close to upstream T3 Code as possible.

## Boundary

The fork may contain only compatibility work required for T3 Code to talk to Pi:

- Pi process discovery and lifecycle
- Pi RPC transport
- provider health and model discovery
- mapping Pi turns, text, reasoning, tool calls, and lifecycle into T3 canonical runtime events
- mapping T3 interruption, steering, model/thinking selection, approvals, and user input back to Pi
- focused contracts, settings wiring, and tests required for that bridge

The fork must not become the home for product-specific agent behavior. Permissions policy, review workflows, memory, compaction strategy, subagent policy, prompts, and other Kees-style behavior belong in Pi extensions.

Custom T3 UI is out of scope unless Pi requires a generic interaction primitive that cannot be represented through existing T3 approval/user-input surfaces.

## Upstream policy

- Keep `main` aligned with `pingdotgg/t3code`.
- Carry Pi support as a small, reviewable patch series.
- Prefer upstream T3 abstractions over fork-specific infrastructure.
- Prefer Pi's public RPC and extension APIs over importing Pi internals.
- Rebase compatibility patches frequently; do not fork unrelated T3 behavior.
- Delete fork code when equivalent upstream support lands.

## Initial milestone

A Pi-backed thread should work from the normal T3 web, desktop, and mobile clients with no Pi-specific client implementation. The server bridge should support:

1. Pi installation/status detection.
2. Live model discovery.
3. Start/resume a thread in a workspace.
4. Stream assistant text and reasoning.
5. Project tool-call lifecycle into T3.
6. Stop/interrupt a running turn.
7. Change model and thinking level where Pi supports it.
8. Bridge Pi extension confirmation/input requests into T3's existing interaction surfaces.
9. Preserve T3's other providers unchanged.

## Non-goals for v1

- Porting Kees features.
- Custom Decisions/Tasks/Impact UI.
- A second execution or persistence engine.
- Pi TUI widgets inside T3.
- Broad provider-framework refactors unrelated to Pi.
