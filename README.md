# opencode-ssh

Run opencode on a remote server. Say "ssh myHost" and all commands run remotely.

- No need to install opencode remotely or expose API keys on the server.
- Reuses the same open ssh connection for performance, remembers last working folder, remote open docker connections etc.

Use to rapidly investigate incidents on remote servers, troubleshoot, analyze logs, data etc.

Targets **OpenCode V2** (`@opencode/plugin` >= 2.1) and **V1** (`@opencode-ai/plugin` >= 1.18.29) from one package.

## How it works

- Opens SSH ControlMaster (`ssh -MNf ...`) for a persistent connection.
- Hooks `tool.execute.before` to wrap `shell` calls with SSH at runtime.
- Disables local file tools (`read`, `write`, `edit`, `patch`, `glob`, `grep`) in remote mode.
- Injects remote-mode instructions into the system prompt (V2: `context` session hook, V1: `experimental.chat.system.transform`).

## Dual V1 + V2 export

```ts
const v2 = Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.add({ ... }))
    await ctx.tool.hook("execute.before", (event) => { ... })
    await ctx.session.hook("context", (event) => { ... })
    return cleanup
  },
})

export default {
  ...v2,
  async server() {
    return { tool: { ... }, "tool.execute.before": ..., "experimental.chat.system.transform": ..., dispose }
  },
}
```

V2 calls `setup()`, V1 calls `server()`. Hook bodies share the same helpers so the two paths cannot drift.
V1 object entrypoints require OpenCode `1.18.29` or newer.

## Setup

**1. Link the plugin** (a real file, not a symlink — OpenCode caches symlinked entrypoints)

```sh
mkdir -p ~/.config/opencode/plugins
printf 'export { default } from "../opencode-ssh/src/index.ts"' > ~/.config/opencode/plugins/opencode-ssh.ts
```

**2. Install deps**

```sh
cd ~/.config/opencode/opencode-ssh && npm install
```

**3. Create an agent**

`.opencode/agent/remote.md`:
```markdown
---
description: Run commands on a remote server via SSH
color: primary
mode: primary
---

When the user says "ssh <host>", use `ssh_connect` with the host name.
When they say "local", use `ssh_disconnect`.
```

## Usage

1. Switch to the **Remote** agent tab.
2. Say **"ssh myHost"** (replace `myHost` with a host from `~/.ssh/config`).
3. Ask anything — `shell` commands automatically run on the remote server.
4. Say **"local"** to disconnect.

## Example `~/.ssh/config`

```
Host myHost
    Hostname 192.100.100.100
    User username
    ServerAliveInterval 60
```

On the remote server, add your public key in `~/.ssh/authorized_keys`

With this entry, you say "ssh myHost" to connect. The `Host` value is the name you use in conversation.
