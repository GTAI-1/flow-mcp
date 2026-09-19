# flow-mcp

Local MCP server that drives Google Flow (flow.google.com) in a dedicated Chrome profile, so
generations run on your Google AI subscription credits instead of the paid API. No extension.

```
Claude ──stdio──> flow-mcp ──CDP──> Chrome (own profile, ~/.flow-mcp/chrome-profile) ──> Flow
```

## Setup

```bash
npm install && npm run build
npm run login   # opens the dedicated Chrome; sign in to Google and open a Flow project
```

Claude Code:

```bash
claude mcp add flow -- node /ABSOLUTE/PATH/flow-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/ABSOLUTE/PATH/flow-mcp/dist/index.js"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `flow_status` | Session state (signed in, project open, plan), queue, pacing |
| `flow_generate` | Queue scenes: prompt, type (video/image), model, aspect, duration, resolution, variants, first/last frame, reference images, `max_credits` cap |
| `flow_wait` | Block until jobs finish; returns file paths |
| `flow_cancel` | Cancel a queued job |

Clips are saved to `~/flow-mcp-out/<project>/scene-NN.ext`.

## Behaviour

- One generation at a time, random 25–70 s pause between them (`FLOW_MCP_PAUSE_MIN_S` / `FLOW_MCP_PAUSE_MAX_S`).
- Before each generation the server reads Flow's own credit quote and skips the scene if it exceeds `max_credits` (default 25).
- The Chrome window must stay open; the machine needs a display.
- Env: `FLOW_MCP_OUTPUT`, `FLOW_MCP_HOME`, `FLOW_MCP_CDP_PORT` (9333), `FLOW_MCP_CHROME`.

This automates Flow's web UI: it can break when Google changes the UI, and automated use may
be against Google's terms. Use on your own account at your own risk.
