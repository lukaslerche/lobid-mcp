import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getGndEntry, matchGndEntities } from "./lobid.js";

const server = new McpServer({
  name: "lobid-mcp",
  version: "1.0.0",
});

function jsonContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

server.registerTool(
  "match_gnd_entities",
  {
    description: "Find plausible GND candidates for one or more search terms",
    inputSchema: z.object({
      terms: z.array(z.string().min(1).max(200)).min(1).max(50).describe("Research terms to match against GND"),
      limitPerTerm: z.number().min(1).max(20).optional().default(5),
    }),
  },
  async ({ terms, limitPerTerm }) =>
    jsonContent({
      matches: await matchGndEntities(terms, limitPerTerm),
    }),
);

server.registerTool(
  "get_gnd_record",
  {
    description: "Get enriched GND record by ID",
    inputSchema: z.object({
      id: z.string().min(1).max(200).describe("GND identifier or full GND URL"),
    }),
  },
  async ({ id }) => jsonContent(await getGndEntry(id)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
