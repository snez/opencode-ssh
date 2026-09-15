# opencode-ssh

Run opencode on a remote server. Say "ssh myHost" and all commands run remotely.

- No need to install opencode remotely or expose API keys on the server.
- Reuses the same open ssh connection for performance, remembers last working folder, remote open docker connections etc.

Use to rapidly investigate incidents on remote servers, troubleshoot, analyze logs, data etc.

## Setup

**1. Copy the plugin**

```sh
mkdir -p ~/.config/opencode/plugins
cp src/index.ts ~/.config/opencode/plugins/remote.ts
```

**2. Create an agent**

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
3. Ask anything — `bash` commands automatically run on the remote server.
4. Say **"local"** to disconnect.

Remote mode is fail-closed. Before every Bash command, the plugin verifies that the
matching SSH control connection is active. If verification fails, the requested command
is blocked rather than executed locally. Reconnect with `ssh_connect`, or say **"local"**
to explicitly return to local execution. Remote intent is retained when a session is
resumed, so restarting OpenCode does not silently restore local Bash execution.

## Hosts with interactive authentication

The plugin cannot receive interactive SSH prompts. Authenticate a control connection in
a separate terminal, replacing `myHost` with an alias from `~/.ssh/config`:

```sh
ssh -M -S "$HOME/.ssh/cm-myHost" myHost
```

Keep that session connected, then say **"ssh myHost"** in OpenCode. The plugin detects
and reuses the authenticated connection. Automatic connection attempts use SSH batch
mode, so TOTP or password prompts are never displayed inside OpenCode.

## How it works

- Opens SSH ControlMaster (`ssh -MNf ...`) for a persistent connection.
- Hooks into `tool.execute.before` to wrap `bash` calls with SSH at runtime.
- Verifies the control connection before every Bash call and blocks on failure.
- Disables local file tools (`read`, `write`, `edit`, `glob`, `grep`) in remote mode.
- Injects remote-mode instructions into the system prompt.

## Example `~/.ssh/config`

```
Host myHost
    Hostname 192.100.100.100
    User username
    ServerAliveInterval 60
```

On the remote server, add your public key in `~/.ssh/authorized_keys`

With this entry, you say "ssh myHost" to connect. The `Host` value is the name you use in conversation.
