import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProjectContextError } from "../shared/errors.js";
import { loadConnectionConfig, type ConnectionConfig } from "../config/connection.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: { result?: unknown };
  content?: Array<{ type: string; text?: string }>;
};

async function withRemoteClient<T>(config: ConnectionConfig, work: (client: Client) => Promise<T>): Promise<T> {
  if (config.mode !== "remote-team" || !config.remoteTeamUrl) {
    throw new ProjectContextError("CONNECTION_NOT_REMOTE", "Switch connection mode to remote-team first.");
  }
  const token = process.env[config.tokenEnv]?.trim();
  if (!token) {
    throw new ProjectContextError(
      "TEAM_UI_NOT_CONFIGURED",
      `Set environment variable ${config.tokenEnv} to a team Bearer token before using the remote MCP database.`,
    );
  }
  const client = new Client({ name: "project-context-ui", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.remoteTeamUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport);
    return await work(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function unpack(result: ToolResult): unknown {
  if (result.isError) {
    const text = result.content?.map((part) => part.text ?? "").join("\n") || "Remote team operation failed.";
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      throw new ProjectContextError(parsed.code ?? "TEAM_OPERATION_FAILED", parsed.message ?? text);
    } catch (error) {
      if (error instanceof ProjectContextError) throw error;
      throw new ProjectContextError("TEAM_OPERATION_FAILED", text);
    }
  }
  if (result.structuredContent && "result" in result.structuredContent) {
    return result.structuredContent.result;
  }
  return result;
}

async function callRemote(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const config = await loadConnectionConfig();
  return withRemoteClient(config, async (client) => {
    const result = await client.callTool({ name, arguments: args }) as ToolResult;
    return unpack(result);
  });
}

export async function remoteTeamListShares(): Promise<unknown> {
  return callRemote("team_projects");
}

export async function remoteTeamCandidates(shareId: string): Promise<unknown> {
  return callRemote("team_candidate_list", { shareId });
}

export async function remoteTeamConflicts(shareId: string): Promise<unknown> {
  return callRemote("team_conflict_list", { shareId });
}

export async function remoteTeamAudit(shareId: string, offset = 0): Promise<unknown> {
  return callRemote("team_audit_export", { shareId, offset });
}

export async function remoteTeamGraph(shareId: string): Promise<unknown> {
  return callRemote("team_code_graph", { shareId });
}

export async function remoteTeamAccept(shareId: string, candidateId: string): Promise<unknown> {
  return callRemote("team_candidate_accept", { shareId, candidateId });
}

export async function remoteTeamResolve(shareId: string, entity: string, eventId: string): Promise<unknown> {
  return callRemote("team_conflict_resolve", { shareId, entity, eventId });
}
