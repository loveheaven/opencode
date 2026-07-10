# OpenCode VSCode Extension

A minimal VSCode extension that connects to a running `opencode` dev server and embeds its web UI in a VSCode webview, so you can hack on opencode and see/use changes immediately.

It does **not** spawn opencode itself. You run `bun run dev web` in a terminal, and the extension just attaches to whatever URL you configure. This means:

- Hot-reload still works: edit opencode source → bun re-runs → press **Reload** in the panel toolbar.
- You can keep multiple opencode instances on different ports.
- You can debug the server with `bun --inspect` and attach VSCode's JS debugger to it in parallel.

## Setup

From the repo root:

```sh
cd packages/vscode-extension
bun install            # picks up @types/vscode and @types/node from the workspace catalog
bun run build
```

This produces `dist/extension.js`.

## Run the extension in a dev VSCode window

Open the repo in VSCode, then in the Run & Debug panel choose **"Run Extension"** (defined in `packages/vscode-extension/.vscode/launch.json`). A new Extension Development Host window opens with the extension installed.

## Start opencode

In a separate terminal:

```sh
cd packages/opencode
bun run dev web --port 4096
```

The default URL the extension looks at is `http://127.0.0.1:4096`. To change it, run **OpenCode: Set Server URL** from the command palette, or edit `opencode.serverUrl` in settings.

If you want to debug the server too:

```sh
cd packages/opencode
bun --inspect=127.0.0.1:9229 ./src/index.ts web --port 4096
```

Then run the **"Attach to opencode dev server"** launch config (or the compound **"Extension + opencode backend"** which launches both).

## Open the panel

Inside the Extension Development Host window: **Cmd+Shift+P → OpenCode: Open Panel**.

The panel embeds `http://127.0.0.1:4096/` in an iframe. The CSP allows WebSocket connections back to the same origin so opencode's event streams work.

## Commands

- **OpenCode: Open Panel** — opens (or reveals) the webview panel.
- **OpenCode: Reload Panel** — re-renders the webview, useful after server restart.
- **OpenCode: Set Server URL** — change the target URL.
- **OpenCode: Open in External Browser** — fall back to your system browser if the webview misbehaves.

## Settings

| Key | Default | Description |
|---|---|---|
| `opencode.serverUrl` | `http://127.0.0.1:4096` | Where the opencode server lives. |
| `opencode.password` | _empty_ | Set to match `OPENCODE_SERVER_PASSWORD` if your server is authenticated. |
| `opencode.healthCheckPath` | `/` | Path used to probe reachability. |
| `opencode.openOnStartup` | `false` | Auto-open the panel when VSCode starts. |

## Notes on Remote-SSH / Dev Containers

`extensionKind` is set to `["workspace", "ui"]`. When you connect to a remote SSH host or open a dev container, VSCode will install this extension on the remote side. Then:

1. Start `bun run dev web --port 4096` **on the remote host / inside the container**.
2. Use **OpenCode: Open Panel** from the remote VSCode window — the iframe loads `http://127.0.0.1:4096/` from the *remote* extension host's network namespace, so it just works.

No SSH tunneling, no port forwarding setup on your side. VSCode handles it.
