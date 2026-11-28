# JetBrains pi ACP

[English](README.md) | [简体中文](README.zh-CN.md)

Connect the [pi coding agent](https://github.com/earendil-works/pi) to JetBrains IDEs through ACP, with session history, permission modes, and file diffs. It implements the stable ACP v1 protocol and runs on Windows, macOS, and Linux.

Requires **Node.js 22.19.0+** and a JetBrains IDE with ACP support, such as IntelliJ IDEA with the Air plugin (`com.intellij.air`). The npm package includes pi `1.6.1`; no global pi installation or build step is required.

## Quick start

1. Sign in to your model provider from a terminal:

   ```bash
   npx --yes jetbrains-pi-acp@0.2.0 --setup
   ```

   In pi, run `/login`, complete sign-in, then exit pi and return to the IDE. Credentials are managed by pi.

2. Choose **Add Custom Agent** in the IDE chat interface. Merge this configuration into `~/.jetbrains/acp.json`, keeping existing agents:

   ```json
   {
     "agent_servers": {
       "pi": {
         "command": "npx",
         "args": ["--yes", "jetbrains-pi-acp@0.2.0"],
         "use_idea_mcp": true,
         "use_custom_mcp": true
       }
     }
   }
   ```

3. Select **pi** and send a message.

The IDE must be able to find `npx`; use its absolute path if needed. Menu locations depend on the IDE/plugin version. See the [JetBrains ACP documentation](https://www.jetbrains.com/help/ai-assistant/acp.html).

## Features

- Stable ACP v1: streaming responses and reasoning, tool call status and output, context usage and cost (`usage_update`). Tool calls appear as pending while the model is still generating their arguments.
- Native pi session history: list, load (with replay), resume, close, and delete sessions.
- Session titles use the pi session name (set by `/name` or a naming extension). Until a session is named, its first message is used instead, without leading attachment references and the Air attachment block: the history list shows it directly, and a new session still unnamed 10 seconds after its first turn has it pushed to the client. This fallback is not saved as the pi session name, so a later name replaces it.
- Context compaction and automatic model retries are shown as tool call cards; compaction summaries also appear when replaying history.
- Session settings for model, reasoning level, and permission mode (full access, standard, read-only, plan).
- File diffs for the built-in `edit` and `write` tools, shown live and when replaying history.
- With the [`pi-background-tasks`](https://www.npmjs.com/package/@maxiaochao/pi-background-tasks) extension installed, background tasks appear above the chat input as an ACP plan (`plan`): running after start, then the result and duration once the completion notice arrives. Finished tasks are cleared on the next prompt.
- stdio and HTTP MCP servers from the client, including IDE tools.
- Local commands: `/status` shows the model, permission mode, tokens, cost, and context usage; `/compact [instructions]` compacts the context; `/reload` reloads pi models, extensions, skills, and prompts. Local commands ignore attachments, including `@` references that Air places before the command, and `/status` and `/reload` ignore extra arguments; input with images is sent to the model as an ordinary prompt. pi extension commands, prompt templates, and skills appear in the command list.
- pi extension dialogs (confirm, select, input) become ACP form elicitations when the client supports them; otherwise they are cancelled. Option numbers added by the extension (such as `1. `) are removed because the client numbers options itself, and plain-text previews in the title are shown in code blocks. Extension notifications become `notice` updates when supported, or reply text during a turn.
- Terminal sign-in, offered when the client declares `auth.terminal` or `_meta["terminal-auth"]` (JetBrains Air): the client reruns the adapter with `PI_ACP_SETUP=1` to open pi for `/login`. Air's sign-in terminal omits the agent's `args`, so the adapter restores the script path (or, when started through `npx`, the package name at the current version) and the original launch arguments through the sign-in arguments. An authentication-required error (`-32000`) is returned for a new session when pi has no usable model, and for a prompt when credentials are missing or fail to authenticate.
- UI text follows the system language: Chinese for `zh*` locales, English otherwise, based on the first non-empty `LC_ALL`, `LC_MESSAGES`, or `LANG`, falling back to the system locale. Prompts sent to the model are always English, except the reason for a denied tool call, which is also shown to you and follows the UI language. Restart the adapter after changing the language.

**Full access is the default and automatically permits tool calls.** Standard mode asks before each tool other than the built-in read-only tools (`read`, `grep`, `find`, `ls`); "Always allow" applies to that tool for the rest of the session. Read-only and plan modes reject those tools, and plan mode also tells the model to only produce a plan. Permission modes are not an OS sandbox, and installed pi extensions remain trusted code.

## Configuration

Append pi options after `--` in the agent's `args`, for example:

```json
["--yes", "jetbrains-pi-acp@0.2.0", "--", "--model", "provider/model-id", "--thinking", "medium"]
```

Use configuration options here, not initial prompts, interactive mode, or session-selection arguments. The adapter manages RPC mode and sessions.

To use an external pi, add `--pi-command <path>` before `--`, or set `PI_ACP_PI_COMMAND`. The path can be an executable or a `.js` entry such as `.../pi-coding-agent/dist/cli.js`; `.js` entries run with the adapter's Node.js. On Windows, pass the `.js` entry, because npm's `.cmd` wrappers cannot be started directly. Verify compatibility when using other pi versions.

Sessions use pi's native storage, normally `~/.pi/agent/sessions/`, and respect `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, and the `sessionDir` setting. Avoid accessing the same session simultaneously from multiple adapters or from pi and the IDE.

Loading or resuming a session starts a new pi process that reads the current configuration, including the MCP servers sent by the client. For an open session, send `/reload` to refresh models, extensions, skills, and prompts. Custom models normally live in `~/.pi/agent/models.json`, or under `PI_CODING_AGENT_DIR` when set; their authentication must also be available to the pi process launched by the IDE.

Restart the agent connection after updating the adapter or changing startup options.

## Limitations

- Tools execute locally through pi; ACP client-side `fs/*` and `terminal/*` are not used. Save editor buffers before asking the agent to read or change files.
- Commands run without interactive input. The adapter itself provides no subagents or background tasks, and there is no session forking or steering into a running turn; a prompt sent while one is running is rejected.
- Diffs have size limits and may be unavailable for binary files or concurrent writes to the same file.
- MCP SSE, audio, and binary embedded resources are unsupported. Image support depends on the model.
- RPC does not support custom terminal panels from extensions.

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
