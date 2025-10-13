import dotenv from "dotenv";
import { z } from "zod";
import { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

dotenv.config();

const ELASTICSEARCH_ENDPOINT =
  process.env.ELASTICSEARCH_ENDPOINT ?? "http://localhost:9200";
const ELASTICSEARCH_API_KEY = process.env.ELASTICSEARCH_API_KEY ?? "";
const INDEX = "invoices";

// Schemas for invoice validation
const ServiceSchema = z.object({
  name: z.string().min(1),
  price: z.number().nonnegative(),
});

const InvoiceSchema = z.object({
  id: z.string().min(1),
  issue_date: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "issue_date must be a valid date string",
  }),
  total_amount: z.number().nonnegative(),
  description: z.string().optional(),
  file_url: z.string().url().optional(),
  services: z.array(ServiceSchema).optional(),
});

type Invoice = z.infer<typeof InvoiceSchema>;

const server = new McpServer({
  name: "Elasticsearch MCP",
  description:
    "A server that retrieves data related with invoices from Elasticsearch",
  version: "1.0.0",
});

const _client = new Client({
  node: ELASTICSEARCH_ENDPOINT,
  auth: {
    apiKey: ELASTICSEARCH_API_KEY,
  },
});

server.registerTool(
  "get-search-by-date-results",
  {
    title: "Get Search By Date Results",
    description:
      "Get the results of a search by date query based on a from and to date. This query will return results based on the issue_date field in the Elasticsearch index. This tool must be used when the user is asking for information about a specific date range. All the results will be related with invoices.",
    inputSchema: {
      from: z.string().describe("The start date of the search"),
      to: z.string().describe("The end date of the search"),
    },
    outputSchema: {
      result: z.array(InvoiceSchema),
    },
  },
  async ({ from, to }) => {
    if (!from || !to) {
      return {
        content: [
          {
            type: "text",
            text: "Both fromDate and toDate parameters are required",
          },
        ],
        isError: true,
      };
    }

    const formattedFrom = formatDate(new Date(from));
    const formattedTo = formatDate(new Date(to));

    function formatDate(date: Date) {
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    }

    const response = await _client.search({
      index: INDEX,
      query: {
        range: {
          issue_date: {
            gte: formattedFrom,
            lte: formattedTo,
            format: "dd/MM/yyyy",
          },
        },
      },
    });

    const populatedResults = response.hits.hits.map((hit) => {
      return JSON.stringify(hit._source);
    });

    const rawResults = response.hits.hits.map((hit) => hit._source ?? null);
    const results: Invoice[] = [];

    rawResults.forEach((r, i) => {
      const parsed = InvoiceSchema.safeParse(r);
      if (parsed.success) results.push(parsed.data);
    });

    return {
      content: [
        {
          type: "text",
          text: populatedResults.join("\n"),
        },
      ],
      structuredContent: {
        result: results,
      },
    };
  }
);

server.registerTool(
  "get-semantic-search-results",
  {
    title: "Get Semantic Search Results",
    description:
      "Get the results of a semantic search query based on a query string. This query will return results based on the semantic field in the Elasticsearch index. This tool must be used when the user is asking for information about a specific topic or concept. All the results will be related with invoices.",
    inputSchema: {
      q: z.string().describe("The query string to search for"),
    },
    outputSchema: {
      result: z.array(InvoiceSchema),
    },
  },
  async ({ q }) => {
    if (!q) {
      return {
        content: [
          {
            type: "text",
            text: "The query parameter is required",
          },
        ],
        isError: true,
      };
    }

    const response = await _client.search({
      index: INDEX,
      query: {
        semantic: {
          field: "semantic_field",
          query: q,
        },
      },
    });

    const populatedResults = response.hits.hits.map((hit) => {
      return JSON.stringify(hit._source);
    });

    const rawResults = response.hits.hits.map((hit) => hit._source ?? null);
    const results: Invoice[] = [];

    rawResults.forEach((r, i) => {
      const parsed = InvoiceSchema.safeParse(r);
      if (parsed.success) results.push(parsed.data);
    });

    return {
      content: [
        {
          type: "text",
          text: populatedResults.join("\n"),
        },
      ],
      structuredContent: {
        result: results,
      },
    };
  }
);

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  // Create a new transport for each request to prevent request ID collisions
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.PORT || "3000");
app
  .listen(port, () => {
    console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
  })
  .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
