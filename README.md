# lobid-mcp

Local MCP server for exploratory GND matching via `lobid` + GND reconciliation API.

Use case:
- researcher provides noisy/ambiguous names
- MCP returns plausible GND candidates
- LLM compares candidates and proposes mappings

Tools:
- `match_gnd_entities`
- `get_gnd_record`

Transport:
- stdio only
- optimized for Claude Desktop / Cursor / OpenCode local usage

## Install

```bash
pnpm install
pnpm build
```

## Run

```bash
pnpm start
```

## OpenCode config

Add MCP server to OpenCode config.

Only use repo-local `opencode.json` in trusted repositories. OpenCode MCP configs execute local programs.

Example:

```json
{
  "mcpServers": {
    "lobid-gnd": {
      "command": "node",
      "args": [
        "/absolute/path/to/lobid-mcp/build/index.js"
      ]
    }
  }
}
```

## Example tool call

```json
{
  "terms": [
    "Goethe",
    "Kafka",
    "Thomas Mann"
  ],
  "limitPerTerm": 5
}
```
