# JetBrains pi ACP

[English](README.md) | [简体中文](README.zh-CN.md)

Connect the [pi coding agent](https://github.com/earendil-works/pi) to JetBrains IDEs through ACP, with session history, permission controls, file diffs, subagents, and background tasks.

Requires **Node.js 22.19.0+** and a JetBrains IDE with ACP support, such as IntelliJ IDEA with the Air plugin (`com.intellij.air`). The npm package includes pi `1.3.0`; no global pi installation or build step is required.

## Quick start

1. Sign in to your model provider from a terminal:

   ```bash
   npx --yes jetbrains-pi-acp@0.1.6 --setup
   ```

   In pi, run `/login`, complete sign-in, then exit pi and return to the IDE. Credentials are managed by pi.

2. Choose **Add Custom Agent** in the IDE chat interface. Merge this configuration into `~/.jetbrains/acp.json`, keeping existing agents:

   ```json
   {
     "agent_servers": {
       "pi": {
         "command": "npx",
         "args": ["--yes", "jetbrains-pi-acp@0.1.6"],
         "use_idea_mcp": true,
         "use_custom_mcp": true
       }
     }
   }
   ```

3. Select **pi** and send a message.

The IDE must be able to find `npx`; use its absolute path if needed. Menu locations depend on the IDE/plugin version. See the [JetBrains ACP documentation](https://www.jetbrains.com/help/ai-assistant/acp.html).

## Features

- ACP v1 and v2 draft support, with streaming responses, reasoning, tool status, terminal output, and usage reporting.
- Native pi session history: list, load, resume, rename, fork, and delete sessions.
- Model and reasoning-level selection, plus full-access, standard, read-only, and plan modes.
- UI text (config names, mode and command descriptions, permission options, errors) follows the system language: Chinese for `zh*` locales, English otherwise, based on the first non-empty `LC_ALL`, `LC_MESSAGES`, or `LANG`, falling back to the system locale. Tool descriptions and system prompts sent to the model are always English. Restart the adapter after changing the language.
- File diffs for built-in `edit`/`write` tools, with optional Air Git patches and per-turn file reports. File report snapshots follow Git ignore rules, including `.gitignore`, while retaining tracked files; non-Git projects or systems without Git use filesystem scanning that skips common dependency, build, and cache directories such as `node_modules/`, `vendor/`, `target/`, `build/`, `dist/`, `coverage/`, `.cache/`, and `.venv/`, including nested directories. Snapshots always skip `.DS_Store`.
- stdio/HTTP MCP forwarding, including IDE tools; subagents and background shell tasks with targeted cancellation.
- Steering, terminal stdin, forms, and URL interactions when supported by the client. Air v1 provides `/stdin text` and `/eof` during command execution.

**Full access is the default and automatically permits tool calls.** Standard mode requests approval for tools other than built-in read-only tools; read-only and plan modes reject those tools. Permission modes are not an OS sandbox, and installed pi extensions remain trusted code. Client capabilities determine which features are available.

## Configuration

Append pi options after `--` in the agent's `args`, for example:

```json
["--yes", "jetbrains-pi-acp@0.1.6", "--", "--model", "provider/model-id", "--thinking", "medium"]
```

Use configuration options here, not initial prompts, interactive mode, or session-selection arguments. The adapter manages RPC mode and sessions.

To use an external pi executable, add `--pi-command /absolute/path/to/pi` before `--`, or set `PI_ACP_PI_COMMAND`. Verify compatibility when using other pi versions.

Sessions use pi's native storage, normally `~/.pi/agent/sessions/`, and respect pi's session-directory settings. History is filtered by the project working directory. Avoid accessing the same session simultaneously from multiple adapters or from pi and the IDE.

The first time you open a historical session after restarting ACP, pi reads its current configuration, including newly added models, extensions, skills, and prompts. For an open session, send `/reload` to refresh configuration and the IDE's model and command lists. Historical sessions retain their selected model and reasoning level; changing the default model in `settings.json` does not switch an existing session. Select the new model in the IDE's model menu. Custom models normally live in `~/.pi/agent/models.json`, or under `PI_CODING_AGENT_DIR` when set. Authentication for added models must also be available to the pi process launched by the IDE.

Restart the agent connection after updating the adapter or changing startup options.

## Limitations

- Tools execute locally through pi; ACP client-side `fs/*` and `terminal/*` execution is not implemented. Save editor buffers before asking the agent to read or change files.
- Terminal input uses stdin pipes, not a PTY. Full-screen apps and TTY password prompts are unsupported; background tasks have no stdin input.
- Only commands the model runs with `interactive: true` accept input. Other commands get an empty stdin (`/dev/null`) like native pi, so commands that read stdin by mistake exit instead of hanging.
- Diffs have size limits and may be unavailable for binary files or older history. File reports scan at most 20,000 entries or two seconds per snapshot and cannot reliably attribute concurrent external changes.
- MCP SSE, audio, and binary embedded resources are unsupported. Image support depends on the model.
- ACP v2 follows a draft schema. Client UI behavior, real provider sign-in, and Windows hardware still need verification.

## Development

From a source checkout:

```bash
npm ci
node src/index.js --setup
npm run --silent config
```

The config command prints JSON with absolute paths without editing IDE settings. For an external pi installation, run `npm run --silent config -- /absolute/path/to/pi`.

```bash
npm test
PI_ACP_SMOKE=1 npm test
```

Smoke tests start real pi processes with a local model stub and do not call remote models.

- [Publishing guide (Chinese)](docs/publishing.md)
- [Registry entry](registry/jetbrains-pi-acp/agent.json) · [Registry submission](https://github.com/agentclientprotocol/registry/pull/691)
- [ACP protocol](https://agentclientprotocol.com/protocol/v1/overview) · [pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

## License

[MIT](LICENSE)
