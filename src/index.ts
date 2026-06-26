#!/usr/bin/env node

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

function errorContent(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown MCP error";

  return jsonContent({
    error: {
      message,
    },
  });
}

server.registerTool(
  "match_gnd_entities",
  {
    description:
      "Search the GND authority ecosystem for plausible entities matching one or more names, concepts, subjects, organizations, places, or works. Use this tool first when resolving ambiguous terms against the GND. If no useful candidates are returned, retry with alternative spellings, singular forms, or related concepts.",
    inputSchema: z.object({
      terms: z.array(z.string().min(1).max(200)).min(1).max(50).describe("Research terms to match against GND"),
      limitPerTerm: z.number().min(1).max(20).optional().default(5),
      entityTypes: z
        .array(z.string().min(1).max(100))
        .max(20)
        .optional()
        .describe("Optional GND type filters such as Person, SubjectHeading, PlaceOrGeographicName, or CorporateBody"),
    }),
  },
  async ({ terms, limitPerTerm, entityTypes }) => {
    try {
      return jsonContent({
        matches: await matchGndEntities(terms, limitPerTerm, entityTypes),
      });
    } catch (error) {
      console.error("match_gnd_entities failed", error);
      return errorContent(error);
    }
  },
);

server.registerTool(
  "get_gnd_record",
  {
    description:
      "Retrieve a compact enriched GND authority record by identifier or canonical GND URL. Use this after candidate matching when additional semantic context is needed.",
    inputSchema: z.object({
      id: z.string().min(1).max(200).describe("GND identifier or full GND URL"),
    }),
  },
  async ({ id }) => {
    try {
      return jsonContent(await getGndEntry(id));
    } catch (error) {
      console.error("get_gnd_record failed", error);
      return errorContent(error);
    }
  },
);

server.registerTool(
  "get_gnd_records",
  {
    description:
      "Retrieve multiple compact enriched GND authority records by identifier or canonical GND URL. Use this to reduce repeated MCP roundtrips when inspecting several entities.",
    inputSchema: z.object({
      ids: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(50)
        .describe("GND identifiers or canonical GND URLs"),
    }),
  },
  async ({ ids }) => {
    try {
      return jsonContent({
        records: await Promise.all(ids.map((id) => getGndEntry(id))),
      });
    } catch (error) {
      console.error("get_gnd_records failed", error);
      return errorContent(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
