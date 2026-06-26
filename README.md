# lobid-mcp

Tiny, deterministic, LLM-facing MCP server for semantic reconciliation against the GND authority ecosystem via `lobid` + the GND reconciliation API.

Designed for local MCP clients such as:
- Claude Code
- Claude Desktop
- OpenCode
- Cursor

Typical workflow:
1. provide ambiguous names, concepts, or Schlagwörter
2. MCP returns plausible GND candidates
3. LLM compares and interprets the results
4. optionally retrieve enriched authority records

The MCP intentionally stays:
- tiny
- deterministic
- stdio-only
- token-aware
- additive instead of transformative
- KISS/YAGNI-first

## Tools

- `match_gnd_entities`
- `get_gnd_record`
- `get_gnd_records`

## Install

No local clone required.

Run directly via `npx`:

```bash
npx lobid-mcp
```

Or install globally:

```bash
npm install -g lobid-mcp
```

Then run:

```bash
lobid-mcp
```

## Claude Desktop / OpenCode config

Example MCP configuration:

```json
{
  "mcpServers": {
    "lobid-gnd": {
      "command": "npx",
      "args": ["lobid-mcp"]
    }
  }
}
```

## Local development

```bash
pnpm install
pnpm build
pnpm start
```

## Example prompts

- "Find likely GND entities for the following Schlagwörter"
- "Search the GND for these ambiguous author names"
- "Resolve these historical concepts against the GND"
- "Find plausible GND subject headings for these terms"

## Example `match_gnd_entities`

```json
{
  "terms": [
    "Goethe",
    "Kafka",
    "Thomas Mann"
  ],
  "limitPerTerm": 5,
  "entityTypes": [
    "Person"
  ]
}
```

## Example `get_gnd_records`

```json
{
  "ids": [
    "118540238",
    "118560239"
  ]
}
```

## Deployment checklist

### Push code to GitHub

```bash
git status
git add .
git commit -m "feat: improve lobid MCP"
git push
```

### Publish to npm

Make sure you are logged into npm:

```bash
npm login
```

Build the package:

```bash
pnpm build
```

Optionally inspect the package contents:

```bash
npm pack --dry-run
```

Publish:

```bash
npm publish
```

### Verify installation

Test from a clean shell:

```bash
npx lobid-mcp
```

Or in Claude Desktop/OpenCode:

```json
{
  "mcpServers": {
    "lobid-gnd": {
      "command": "npx",
      "args": ["lobid-mcp"]
    }
  }
}
```
