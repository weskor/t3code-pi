# Pi provider v1

## Goal

Add Pi as a first-class T3 Code provider while keeping this fork a thin compatibility layer.

See `docs/fork-scope.md` for the architectural boundary.

## References

- Historical upstream implementation: `pingdotgg/t3code#3818`
- Preserved reference branch in this fork: `reference/pi-provider-pr-3818`
- Active implementation branch: `feat/pi-provider`

## Acceptance criteria

- [ ] Detect a local Pi install and expose useful provider status.
- [ ] Discover available Pi models without hard-coding a catalog.
- [ ] Start and resume a Pi-backed thread in a T3 workspace.
- [ ] Stream assistant text and reasoning into T3 canonical runtime events.
- [ ] Map Pi tool-call start/update/end lifecycle into T3 canonical items.
- [ ] Stop/interrupt an active Pi turn cleanly.
- [ ] Support model and thinking-level changes where Pi RPC supports them.
- [ ] Bridge Pi extension confirmation/input requests to existing T3 approval/user-input surfaces.
- [ ] Keep web, desktop, and mobile client code Pi-agnostic unless a genuinely generic interaction primitive is missing.
- [ ] Keep Codex, Claude, Cursor, Grok, and OpenCode behavior unchanged.
- [ ] Add focused unit/integration coverage for RPC parsing, lifecycle mapping, resume, interrupt, and extension UI bridging.

## Explicit non-goals

- Port Kees product features into T3.
- Custom Decisions/Tasks/Impact UI.
- Kees-specific permission, review, memory, compaction, or subagent policy in this repository.
- A separate Pi execution or persistence layer.
- Pi TUI widgets inside T3.

## Implementation order

1. Reconcile the historical `PiRpcClient` with current T3 provider contracts.
2. Add a minimal `PiDriver` plus provider status and model discovery.
3. Port the `PiAdapter` event mapping against current canonical events.
4. Add extension UI and approval bridging.
5. Add only the smallest settings/model-picker wiring required to select Pi.
6. Validate against a real `pi --mode rpc` install before widening scope.

## Maintenance rule

Anything that changes how the agent behaves should default to a Pi extension, not a T3 fork change. Anything in the fork should be deletable when upstream T3 gains equivalent Pi support.
