import { execSync } from "child_process"
import path from "path"
import os from "os"
import { writeFileSync } from "fs"
import { Plugin } from "@opencode/plugin"
import { tool } from "@opencode-ai/plugin"

type SessionState = {
  host: string
  socketPath: string
}

const sessionMap = new Map<string, SessionState>()

function sock(host: string) {
  // Distinct name so it never collides with sockets the user's ~/.ssh/config
  // creates via ControlPath cm-%r@%h:%p.
  return path.join(os.homedir(), ".ssh", `cm-opencode-${host.replace(/[^A-Za-z0-9.-]/g, "_")}`)
}

function ensureSentinel(): string {
  const p = path.join(os.tmpdir(), "__opencode_remote_mode__")
  try {
    writeFileSync(
      p,
      "This tool is not available in remote SSH mode.\nUse the shell tool with cat/tee/grep/find over SSH instead.\n",
    )
  } catch {}
  return p
}

const REMOTE_SYSTEM = (host: string) =>
  [
    "",
    "## Remote SSH Mode",
    "",
    `You are connected to **${host}** via persistent SSH.`,
    "",
    "1. The **shell** tool is automatically wrapped with SSH. Do NOT add SSH yourself.",
    "2. Use shell with `cat`, `tee`, `grep`, `find` for all remote file ops.",
    "3. Native `read`/`write`/`edit`/`glob`/`grep` tools are disabled in remote mode.",
    '4. Say "local" to disconnect.',
  ].join("\n")

let sentinel: string

function connect(host: string, sessionID: string): string {
  const socketPath = sock(host)

  const existing = sessionMap.get(sessionID)
  if (existing) {
    try {
      execSync(`ssh -O stop -S "${existing.socketPath}" "${existing.host}"`, { stdio: "pipe" })
    } catch {}
  }

  try {
    // Master forks into the background and inherits its parent's pipes, so a
    // piped stdio never reaches EOF. ignore lets execSync return as soon as
    // ssh exits (verified: 1.2s vs. ETIMEDOUT at 15s).
    execSync(`ssh -MNf -S "${socketPath}" "${host}"`, { stdio: "ignore", timeout: 15000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Failed to connect to ${host}: ${msg}`
  }

  sessionMap.set(sessionID, { host, socketPath })

  return [
    `SSH connection to **${host}** established. All shell commands will now run remotely.`,
    "Use shell with `cat`, `tee`, `grep`, `find` for file operations.",
    'Say "local" to disconnect.',
  ].join("\n")
}

function disconnect(sessionID: string): string {
  const state = sessionMap.get(sessionID)
  if (!state) return "Not currently connected."

  try {
    execSync(`ssh -O stop -S "${state.socketPath}" "${state.host}"`, { stdio: "pipe" })
  } catch {}
  sessionMap.delete(sessionID)

  return "Disconnected. Commands now run locally."
}

function cleanup() {
  for (const state of sessionMap.values()) {
    try {
      execSync(`ssh -O stop -S "${state.socketPath}" "${state.host}"`, { stdio: "pipe" })
    } catch {}
  }
  sessionMap.clear()
}

const CONNECT_DESCRIPTION =
  "Open a persistent SSH connection to a remote server. Call this when the user says 'ssh <host>' or asks to connect to a server. The host must be defined in ~/.ssh/config."

const DISCONNECT_DESCRIPTION =
  "Close the persistent SSH connection and return to local mode. Call this when the user says 'local' or asks to disconnect."

/** Rewrites args of local-only tools so they fail harmlessly while in remote mode. */
function neutralizeLocalTool(name: string, args: Record<string, unknown>): boolean {
  switch (name) {
    case "read":
      args.path = args.filePath = sentinel
      args.offset = undefined
      args.limit = undefined
      return true
    case "write":
      args.path = args.filePath = path.join(os.tmpdir(), "__opencode_remote_write__")
      args.content = "This tool is not available in remote mode."
      return true
    case "edit":
      args.path = args.filePath = sentinel
      args.oldString = "SENTINEL_MARKER_THAT_WILL_NEVER_EXIST"
      args.newString = ""
      args.replaceAll = false
      return true
    case "patch":
      args.patchText = "*** Begin Patch\n*** End Patch\n"
      return true
    case "glob":
      args.pattern = "__OPENCODE_REMOTE_GLOB_UNAVAILABLE__"
      args.path = "/tmp"
      return true
    case "grep":
      args.pattern = "^__OPENCODE_REMOTE_GREP_UNAVAILABLE__$"
      args.path = "/tmp"
      args.include = undefined
      return true
    default:
      return false
  }
}

/** Wraps a shell command with SSH when the session is in remote mode. */
function wrapShell(name: string, args: Record<string, unknown>, state: SessionState): void {
  if (name !== "shell" && name !== "bash") return
  const cmd = typeof args.command === "string" ? args.command : ""
  if (cmd.includes(`-o ControlPath="${state.socketPath}"`)) return

  // Base64 keeps pipes, quotes and newlines intact: the local shell sees only
  // [A-Za-z0-9+/=] and cannot split the command, so everything runs remotely.
  const encoded = Buffer.from(cmd, "utf8").toString("base64")
  const decode = `echo ${encoded} | base64 -d 2>/dev/null || echo ${encoded} | base64 -D`

  args.command = `ssh -o ControlMaster=no -o ControlPath="${state.socketPath}" "${state.host}" 'sh -c "$(${decode})"'`
  if (typeof args.description === "string") {
    args.description = `[remote ${state.host}] ${args.description}`
  }
}

const v2 = Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    sentinel ??= ensureSentinel()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ssh_connect",
        description: CONNECT_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            host: { type: "string", description: "SSH host name from ~/.ssh/config, e.g. 'myHost'" },
          },
          required: ["host"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: connect((input as { host: string }).host, context.sessionID) }
        },
      })

      editor.add({
        name: "ssh_disconnect",
        description: DISCONNECT_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          return { content: disconnect(context.sessionID) }
        },
      })
    })

    await ctx.tool.hook("execute.before", (event) => {
      const state = sessionMap.get(event.sessionID)
      if (!state) return

      const input = event.input as Record<string, unknown> | undefined
      if (!input || typeof input !== "object") return

      wrapShell(event.tool, input, state)
      neutralizeLocalTool(event.tool, input)
    })

    await ctx.session.hook("context", (event) => {
      const state = sessionMap.get(event.sessionID)
      if (!state) return
      event.system.push({ type: "text", text: REMOTE_SYSTEM(state.host) })
    })

    return cleanup
  },
})

export default {
  ...v2,
  /** OpenCode 1.x entrypoint. */
  async server() {
    sentinel ??= ensureSentinel()

    return {
      tool: {
        ssh_connect: tool({
          description: CONNECT_DESCRIPTION,
          args: {
            host: tool.schema.string().describe("SSH host name from ~/.ssh/config, e.g. 'myHost'"),
          },
          async execute(args, ctx) {
            return connect(args.host, ctx.sessionID)
          },
        }),
        ssh_disconnect: tool({
          description: DISCONNECT_DESCRIPTION,
          args: {},
          async execute(_args, ctx) {
            return disconnect(ctx.sessionID)
          },
        }),
      },

      "tool.execute.before": async (input, output) => {
        const state = sessionMap.get(input.sessionID)
        if (!state) return

        const args = output.args as Record<string, unknown> | undefined
        if (!args || typeof args !== "object") return

        wrapShell(input.tool, args, state)
        neutralizeLocalTool(input.tool, args)
      },

      "experimental.chat.system.transform": async (input, output) => {
        const state = input.sessionID ? sessionMap.get(input.sessionID) : undefined
        if (!state) return
        output.system.push(REMOTE_SYSTEM(state.host))
      },

      dispose: async () => cleanup(),
    }
  },
}
