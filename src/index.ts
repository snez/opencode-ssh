import { execFileSync } from "child_process"
import path from "path"
import os from "os"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { createHash, randomBytes } from "crypto"
import { z } from "zod"

type SessionState = {
  host: string
  socketPath: string
  status: "connecting" | "connected" | "unavailable"
}

const sessionMap = new Map<string, SessionState>()

function sock(host: string) {
  return path.join(os.homedir(), ".ssh", `cm-${host}`)
}

function validHost(host: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function controlMasterActive(socketPath: string, host: string) {
  try {
    execFileSync("ssh", ["-O", "check", "-S", socketPath, host], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

function blockedBashCommand(host: string) {
  const message = `opencode-ssh: remote connection to ${host} is unavailable; command blocked to prevent local execution. Run ssh_connect again or say "local".\n`
  return `printf '%s' ${shellQuote(message)} >&2; exit 125`
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-ssh-"))
const stateDir = path.join(os.homedir(), ".cache", "opencode-ssh", "sessions")
mkdirSync(stateDir, { recursive: true, mode: 0o700 })

function statePath(sessionID: string) {
  return path.join(stateDir, createHash("sha256").update(sessionID).digest("hex"))
}

function saveSessionState(sessionID: string, state: SessionState) {
  const target = statePath(sessionID)
  const temporary = `${target}.${randomBytes(16).toString("hex")}`
  try {
    writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function getSessionState(sessionID: string) {
  const current = sessionMap.get(sessionID)
  if (current) return current

  try {
    const saved = JSON.parse(readFileSync(statePath(sessionID), "utf8")) as Partial<SessionState>
    const valid =
      typeof saved.host === "string" &&
      validHost(saved.host) &&
      saved.socketPath === sock(saved.host) &&
      ["connecting", "connected", "unavailable"].includes(saved.status ?? "")

    if (!valid) return undefined

    const state = saved as SessionState
    sessionMap.set(sessionID, state)
    return state
  } catch {
    return undefined
  }
}

function deleteSessionState(sessionID: string) {
  sessionMap.delete(sessionID)
  rmSync(statePath(sessionID), { force: true })
}

function ensureSentinel(): string {
  const p = path.join(tempDir, "remote-mode")
  try {
    writeFileSync(
      p,
      "This tool is not available in remote SSH mode.\nUse the bash tool with cat/tee/grep/find over SSH instead.\n",
      { flag: "wx", mode: 0o600 },
    )
  } catch {}
  return p
}

let sentinel: string

export default {
  id: "opencode-ssh",
  server: async () => {
    sentinel ??= ensureSentinel()

    return {
      tool: {
        ssh_connect: {
          description:
            "Open or reuse a persistent SSH connection. Never retry automatically after failure. Interactive authentication must first be completed in a separate terminal using the control-socket command returned by this tool.",
          args: {
            host: z.string().describe("SSH host name from ~/.ssh/config, e.g. 'myHost'"),
          },
          async execute(args, ctx) {
            const host = args.host
            if (!validHost(host)) {
              return "Invalid SSH host. Use a host alias from ~/.ssh/config."
            }
            const socketPath = sock(host)

            const existing = getSessionState(ctx.sessionID)
            if (existing) {
              if (existing.host === host && controlMasterActive(existing.socketPath, existing.host)) {
                existing.status = "connected"
                saveSessionState(ctx.sessionID, existing)
                return `Already connected to ${host}.`
              }
              try {
                execFileSync("ssh", ["-O", "stop", "-S", existing.socketPath, existing.host], { stdio: "pipe" })
              } catch {}
            }

            const state: SessionState = { host, socketPath, status: "connecting" }
            sessionMap.set(ctx.sessionID, state)
            saveSessionState(ctx.sessionID, state)

            if (controlMasterActive(socketPath, host)) {
              state.status = "connected"
              saveSessionState(ctx.sessionID, state)
              return {
                title: `Connected to ${host}`,
                output: [
                  `Reused the existing SSH connection to **${host}**. All bash commands will now run remotely.`,
                  `Say "local" to disconnect.`,
                ].join("\n"),
              }
            }

            try {
              execFileSync("ssh", ["-o", "BatchMode=yes", "-MNf", "-S", socketPath, host], {
                stdio: "pipe",
                timeout: 15000,
              })
            } catch (e) {
              state.status = "unavailable"
              saveSessionState(ctx.sessionID, state)
              const msg = e instanceof Error ? e.message : String(e)
              return [
                `Failed to connect to ${host}: ${msg}`,
                `Do not retry automatically. Interactive authentication is disabled inside OpenCode.`,
                `Remote mode remains fail-closed: bash commands are blocked until connection succeeds or the user says "local".`,
                `In a separate terminal, run this exact command and complete authentication there:`,
                `ssh -M -S ${shellQuote(socketPath)} ${shellQuote(host)}`,
                `Keep that terminal connected, then ask the user to run "ssh ${host}" again in OpenCode.`,
              ].join("\n")
            }

            state.status = "connected"
            saveSessionState(ctx.sessionID, state)

            return {
              title: `Connected to ${host}`,
              output: [
                `SSH connection to **${host}** established. All bash commands will now run remotely.`,
                `Use bash with \`cat\`, \`tee\`, \`grep\`, \`find\` for file operations.`,
                `Say "local" to disconnect.`,
              ].join("\n"),
            }
          },
        },

        ssh_disconnect: {
          description: "Close the persistent SSH connection and return to local mode. Call this when the user says 'local' or asks to disconnect.",
          args: {},
          async execute(_args, ctx) {
            const state = getSessionState(ctx.sessionID)
            if (!state) return "Not currently connected."

            try {
              execFileSync("ssh", ["-O", "stop", "-S", state.socketPath, state.host], { stdio: "pipe" })
            } catch {}
            deleteSessionState(ctx.sessionID)

            return "Disconnected. Commands now run locally."
          },
        },
      },

      "tool.execute.before": async (input, output) => {
        const state = getSessionState(input.sessionID)
        if (!state) return

        if (input.tool === "bash") {
          if (state.status !== "connected" || !controlMasterActive(state.socketPath, state.host)) {
            state.status = "unavailable"
            saveSessionState(input.sessionID, state)
            output.args.command = blockedBashCommand(state.host)
            output.args.description = `[blocked remote ${state.host}] SSH connection unavailable`
            return
          }

          const cmd = output.args.command
          const wrappedPrefix = ["ssh", "-S", state.socketPath, state.host].map(shellQuote).join(" ")
          if (cmd.startsWith(`${wrappedPrefix} `)) return
          output.args.command = ["ssh", "-S", state.socketPath, state.host, cmd].map(shellQuote).join(" ")
          if (output.args.description) {
            output.args.description = `[remote ${state.host}] ${output.args.description}`
          }
          return
        }

        if (input.tool === "read") {
          output.args.filePath = sentinel
          output.args.offset = undefined
          output.args.limit = undefined
          return
        }

        if (input.tool === "write") {
          output.args.filePath = path.join(tempDir, `remote-write-${randomBytes(16).toString("hex")}`)
          output.args.content = "This tool is not available in remote mode."
          return
        }

        if (input.tool === "edit") {
          output.args.filePath = sentinel
          output.args.oldString = "SENTINEL_MARKER_THAT_WILL_NEVER_EXIST"
          output.args.newString = ""
          output.args.replaceAll = false
          return
        }

        if (input.tool === "glob") {
          output.args.pattern = `__OPECODE_REMOTE_GLOB_UNAVAILABLE__`
          output.args.path = "/tmp"
          return
        }

        if (input.tool === "grep") {
          output.args.pattern = `^__OPECODE_REMOTE_GREP_UNAVAILABLE__$`
          output.args.path = "/tmp"
          output.args.include = undefined
          return
        }
      },

      "experimental.chat.system.transform": async (input, output) => {
        const state = input.sessionID ? getSessionState(input.sessionID) : undefined
        if (!state) return

        output.system.push(
          state.status === "connected"
            ? [
                "",
                "## Remote SSH Mode",
                "",
                `You are connected to **${state.host}** via persistent SSH.`,
                "Local platform and working-directory metadata describe the OpenCode host, not the remote host.",
                "",
                "1. The **bash** tool verifies the connection and is automatically wrapped with SSH. Do NOT add SSH yourself.",
                "2. Use bash with `cat`, `tee`, `grep`, `find` for all remote file ops.",
                "3. Native `read`/`write`/`edit`/`glob`/`grep` tools are disabled in remote mode.",
                "4. Say \"local\" to disconnect.",
              ].join("\n")
            : [
                "",
                "## Remote SSH Mode Unavailable",
                "",
                `Remote mode was requested for **${state.host}**, but its SSH connection is unavailable.`,
                "All bash and native file-tool operations are blocked to prevent accidental local execution.",
                "Use ssh_connect to reconnect, or say \"local\" to explicitly return to local mode.",
              ].join("\n"),
        )
      },
    }
  },
}
