# Remote control is a bridge mode, reached only through the tailnet

Decided 2026-08-29, during overhaul prep. Controlling an Artemis on another
machine is built as a fourth renderer bridge mode (`remote`, beside
`preload`/`mock`/`unavailable`): the existing UI *is* the remote UI, speaking
the same `IpcRequestMap`/`IpcPushMap` vocabulary over HTTP plus an event
stream, rather than a separate remote-viewer app or a synced-state design. The
serving side stays loopback-only with reachability delegated to the tailnet
(Tailscale) — no LAN bind setting, no TLS of our own, no QR pairing; a
connection is still a manually carried address + token. Remote terminals are in
scope (PTY bytes ride the event stream; rendering is local xterm); window
chrome, native dialogs, and the browser dock's `WebContentsView` do not cross
the wire and degrade absent-with-reason under the existing capability-flag
discipline.

Rejected: binding the desktop server beyond loopback (attack surface with no
present user — the code's own comment demands any change "arrive with its own
warning surface") and building transport security ourselves when the tailnet
already provides identity and encryption.
