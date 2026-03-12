import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Resolve paths relative to this file (works on any machine)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.join(__dirname, "videosdk-docs", "ai_agents");

// ---------------------------------------------------------------------------
// 1. Load & chunk every .md file under ai_agents/
// ---------------------------------------------------------------------------
function loadAllDocs(dir) {
  let chunks = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      chunks = chunks.concat(loadAllDocs(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = fs.readFileSync(fullPath, "utf8");
      const relativePath = path.relative(DOCS_DIR, fullPath);
      chunks = chunks.concat(chunkByHeadings(content, relativePath));
    }
  }
  return chunks;
}

/**
 * Split a markdown file into chunks at every heading (# through ###).
 * Each chunk keeps its heading, the file path, and the body text.
 */
function chunkByHeadings(markdown, filePath) {
  const lines = markdown.split("\n");
  const chunks = [];
  let heading = filePath; // default heading = filename
  let body = [];

  const flush = () => {
    const text = body.join("\n").trim();
    if (text.length > 0) {
      chunks.push({ filePath, heading, text });
    }
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.*)/);
    if (match) {
      flush();
      heading = match[2].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush(); // last chunk

  return chunks;
}

// Pre-load everything at startup
const ALL_CHUNKS = loadAllDocs(DOCS_DIR);
console.error(
  `[videosdk-docs] Loaded ${ALL_CHUNKS.length} chunks from ${new Set(ALL_CHUNKS.map((c) => c.filePath)).size} files`
);

// ---------------------------------------------------------------------------
// 2. Search helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words */
function tokenize(str) {
  return str.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/**
 * Score a chunk against a query.
 * Uses simple term-frequency matching across heading + body text.
 * Heading matches are weighted 3× higher.
 */
function scoreChunk(chunk, queryTokens) {
  const headingTokens = tokenize(chunk.heading);
  const bodyTokens = tokenize(chunk.text);
  let score = 0;

  for (const qt of queryTokens) {
    // Exact token matches
    score += headingTokens.filter((t) => t === qt).length * 3;
    score += bodyTokens.filter((t) => t === qt).length;

    // Partial / substring matches (lower weight)
    score += headingTokens.filter((t) => t.includes(qt) && t !== qt).length * 1.5;
    score += bodyTokens.filter((t) => t.includes(qt) && t !== qt).length * 0.5;
  }

  return score;
}

function searchDocs(query, topK = 5) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored = ALL_CHUNKS.map((chunk) => ({
    ...chunk,
    score: scoreChunk(chunk, queryTokens),
  }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

/** List every unique file path */
function listDocs() {
  const files = [...new Set(ALL_CHUNKS.map((c) => c.filePath))].sort();
  return files;
}

/** Return full content of a specific doc file */
function getDoc(filePath) {
  const absPath = path.join(DOCS_DIR, filePath);
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, "utf8");
}

// ---------------------------------------------------------------------------
// 3. MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "videosdk-ai-agents-docs", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---- List Tools ---------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "SearchDocsGoogle",
      description:
        "Search VideoSDK AI Agents documentation. Returns the most relevant doc chunks for a query. Use this to find information about agents, pipelines, plugins (LLM, STT, TTS), deployments, etc.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g. 'how to configure OpenAI TTS plugin')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "list_docs",
      description:
        "List all available documentation files in the VideoSDK AI Agents docs.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_doc",
      description:
        "Get the full content of a specific documentation file by its relative path (e.g. 'plugins/llm/openai.md').",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative path of the doc file (from list_docs output)",
          },
        },
        required: ["path"],
      },
    },
  ],
}));

// ---- Call Tool ----------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // -- search_docs --------------------------------------------------------
  if (name === "SearchDocsGoogle") {
    const results = searchDocs(args.query);

    if (results.length === 0) {
      return {
        content: [
          { type: "text", text: "No relevant documentation found for that query." },
        ],
      };
    }

    const text = results
      .map(
        (r, i) =>
          `--- Result ${i + 1} (score: ${r.score.toFixed(1)}) ---\n` +
          `File: ${r.filePath}\n` +
          `Section: ${r.heading}\n\n` +
          `${r.text.slice(0, 1500)}`
      )
      .join("\n\n");

    return { content: [{ type: "text", text }] };
  }

  // -- list_docs ----------------------------------------------------------
  if (name === "list_docs") {
    const files = listDocs();
    return {
      content: [
        {
          type: "text",
          text: `Found ${files.length} documentation files:\n\n${files.join("\n")}`,
        },
      ],
    };
  }

  // -- get_doc ------------------------------------------------------------
  if (name === "get_doc") {
    const content = getDoc(args.path);
    if (content === null) {
      return {
        content: [
          { type: "text", text: `File not found: ${args.path}` },
        ],
      };
    }
    return { content: [{ type: "text", text: content }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// ---- Start --------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
