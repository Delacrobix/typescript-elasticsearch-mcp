import { z } from "zod";
import { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI from "openai";

const ELASTICSEARCH_ENDPOINT =
  process.env.ELASTICSEARCH_ENDPOINT ?? "http://localhost:9200";
const ELASTICSEARCH_API_KEY = process.env.ELASTICSEARCH_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const INDEX = "documents";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const _client = new Client({
  node: ELASTICSEARCH_ENDPOINT,
  auth: {
    apiKey: ELASTICSEARCH_API_KEY,
  },
});

const DocumentSchema = z.object({
  id: z.number(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
});

const SearchResultSchema = z.object({
  id: z.number(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  score: z.number(),
});

type Document = z.infer<typeof DocumentSchema>;
type SearchResult = z.infer<typeof SearchResultSchema>;

const searchContextStore = new Map<string, SearchResult[]>();

const server = new McpServer({
  name: "Elasticsearch RAG MCP",
  description:
    "A RAG server using Elasticsearch. Provides tools for document search, result summarization, and source citation.",
  version: "1.0.0",
});

server.registerTool(
  "search_docs",
  {
    title: "Search Documents",
    description:
      "Search for documents in Elasticsearch using full-text search. Returns the most relevant documents with their content, title, tags, and relevance score. Use this tool first to retrieve context before answering questions.",
    inputSchema: {
      query: z
        .string()
        .describe("The search query terms to find relevant documents"),
      max_results: z.number().describe("Maximum number of results to return"),
      session_id: z
        .string()
        .optional()
        .describe(
          "Session ID to store search context for later summarization and citation"
        ),
    },
    outputSchema: {
      results: z.array(SearchResultSchema),
      total: z.number(),
      session_id: z.string().optional(),
    },
  },
  async ({ query, max_results = 5, session_id }) => {
    if (!query) {
      return {
        content: [
          {
            type: "text",
            text: "Query parameter is required",
          },
        ],
        isError: true,
      };
    }

    try {
      const response = await _client.search({
        index: INDEX,
        size: max_results,
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: query,
                  fields: ["title^2", "content", "tags"],
                  fuzziness: "AUTO",
                },
              },
            ],
            should: [
              {
                match_phrase: {
                  title: {
                    query: query,
                    boost: 2,
                  },
                },
              },
            ],
          },
        },
        highlight: {
          fields: {
            title: {},
            content: {},
          },
        },
      });

      const results: SearchResult[] = response.hits.hits.map((hit: any) => {
        const source = hit._source as Document;

        return {
          id: source.id,
          title: source.title,
          content: source.content,
          tags: source.tags,
          score: hit._score ?? 0,
        };
      });

      // Store context for later use
      const contextId = session_id || `session_${Date.now()}`;
      searchContextStore.set(contextId, results);

      const contentText = results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title} (score: ${r.score.toFixed(
              2
            )})\n${r.content.substring(0, 200)}...`
        )
        .join("\n\n");

      const totalHits =
        typeof response.hits.total === "number"
          ? response.hits.total
          : response.hits.total?.value ?? 0;

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} relevant documents:\n\n${contentText}`,
          },
        ],
        structuredContent: {
          results: results,
          total: totalHits,
          session_id: contextId,
        },
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching documents: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "summarize_results",
  {
    title: "Summarize Search Results",
    description:
      "Summarize and synthesize information from previously retrieved documents to answer a user question. Requires a session_id from a previous search_docs call. Generates a coherent answer based on the retrieved content.",
    inputSchema: {
      session_id: z.string().describe("Session ID from the search_docs call"),
      question: z.string().describe("The question to answer"),
      max_length: z
        .number()
        .describe("Maximum length of the summary in characters"),
    },
    outputSchema: {
      summary: z.string(),
      sources_used: z.number(),
    },
  },
  async ({ session_id, question, max_length = 500 }) => {
    if (!session_id || !question) {
      return {
        content: [
          {
            type: "text",
            text: "Both session_id and question parameters are required",
          },
        ],
        isError: true,
      };
    }

    const searchResults = searchContextStore.get(session_id);

    if (!searchResults || searchResults.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No search results found for this session. Please call search_docs first.",
          },
        ],
        isError: true,
      };
    }

    try {
      const context = searchResults
        .slice(0, 5)
        .map((r, i) => `[Document ${i + 1}: ${r.title}]\n${r.content}`)
        .join("\n\n---\n\n");

      // Generate summary with OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant that answers questions based on provided documents. Synthesize information from the documents to answer the user's question accurately and concisely. If the documents don't contain relevant information, say so.",
          },
          {
            role: "user",
            content: `Question: ${question}\n\nRelevant Documents:\n${context}`,
          },
        ],
        max_tokens: Math.min(Math.ceil(max_length / 4), 1000),
        temperature: 0.3,
      });

      const summary =
        "AI generated summary: " + completion.choices[0]?.message?.content ||
        "No summary generated.";

      return {
        content: [
          {
            type: "text",
            text: summary,
          },
        ],
        structuredContent: {
          summary: summary,
          sources_used: searchResults.length,
        },
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error generating summary: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 3: Cite sources
server.registerTool(
  "cite_sources",
  {
    title: "Cite Sources",
    description:
      "Return citation information for documents used in the previous search. Provides document IDs, titles, and tags for proper attribution. Use this after summarize_results to provide references.",
    inputSchema: {
      session_id: z.string().describe("Session ID from the search_docs call"),
    },
    outputSchema: {
      citations: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          tags: z.array(z.string()),
          relevance_score: z.number(),
        })
      ),
    },
  },
  async ({ session_id }) => {
    if (!session_id) {
      return {
        content: [
          {
            type: "text",
            text: "session_id parameter is required",
          },
        ],
        isError: true,
      };
    }

    const searchResults = searchContextStore.get(session_id);

    if (!searchResults || searchResults.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No search results found for this session. Please call search_docs first.",
          },
        ],
        isError: true,
      };
    }

    const citations = searchResults.map((r) => ({
      id: r.id,
      title: r.title,
      tags: r.tags,
      relevance_score: r.score,
    }));

    const citationText = citations
      .map(
        (c, i) =>
          `[${i + 1}] ID: ${c.id}, Title: "${c.title}", Tags: ${c.tags.join(
            ", "
          )}, Score: ${c.relevance_score.toFixed(2)}`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Sources used (${citations.length}):\n\n${citationText}`,
        },
      ],
      structuredContent: {
        citations: citations,
      },
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
