import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { ProjectContextError } from "../shared/errors.js";

const connectionSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["local", "remote-team"]),
  remoteTeamUrl: z.string().url().optional(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).default("PROJECT_CONTEXT_TEAM_TOKEN"),
});

export type ConnectionConfig = z.infer<typeof connectionSchema>;

export type ConnectionStatus = {
  connectionId: string;
  mode: "local" | "remote-team";
  remoteTeamUrl?: string;
  tokenEnv: string;
  tokenConfigured: boolean;
  summary: string;
};

export function connectionFilePath(): string {
  const base = process.env.APPDATA
    ?? process.env.XDG_CONFIG_HOME
    ?? join(homedir(), ".config");
  return join(base, "project-context", "connection.json");
}

const DEFAULT: ConnectionConfig = {
  version: 1,
  mode: "local",
  tokenEnv: "PROJECT_CONTEXT_TEAM_TOKEN",
};

export async function loadConnectionConfig(): Promise<ConnectionConfig> {
  try {
    const raw = await readFile(connectionFilePath(), "utf8");
    const parsed = connectionSchema.parse(JSON.parse(raw));
    return normalizeConnection(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT };
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new ProjectContextError("INVALID_CONNECTION_CONFIG", `Invalid connection config at ${connectionFilePath()}`);
    }
    throw error;
  }
}

export async function saveConnectionConfig(input: {
  mode: "local" | "remote-team";
  remoteTeamUrl?: string;
  tokenEnv?: string;
}): Promise<ConnectionStatus> {
  const tokenEnv = input.tokenEnv ?? "PROJECT_CONTEXT_TEAM_TOKEN";
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)) {
    throw new ProjectContextError("INVALID_CONNECTION_CONFIG", "tokenEnv must look like an environment variable name.");
  }
  let remoteTeamUrl: string | undefined;
  if (input.mode === "remote-team") {
    if (!input.remoteTeamUrl) {
      throw new ProjectContextError(
        "INVALID_CONNECTION_CONFIG",
        "Remote team mode requires a MCP URL, for example https://host/mcp or http://192.168.1.10:8787/mcp.",
      );
    }
    remoteTeamUrl = validateRemoteTeamUrl(input.remoteTeamUrl);
  }
  const config: ConnectionConfig = {
    version: 1,
    mode: input.mode,
    ...(remoteTeamUrl ? { remoteTeamUrl } : {}),
    tokenEnv,
  };
  const target = connectionFilePath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return connectionStatus(config);
}

export async function connectionStatusFromDisk(): Promise<ConnectionStatus> {
  return connectionStatus(await loadConnectionConfig());
}

export function connectionStatus(config: ConnectionConfig): ConnectionStatus {
  const summary = config.mode === "local"
    ? "使用本机 SQLite 数据库；团队审核仍走本机 team 服务（需 PROJECT_CONTEXT_TEAM_UI_TOKEN）。"
    : `可选连接远程团队 MCP：${config.remoteTeamUrl ?? "（未设置 URL）"}；令牌只读环境变量 ${config.tokenEnv}，不会写入配置文件或网页。`;
  return {
    connectionId: connectionIdentity(config),
    mode: config.mode,
    ...(config.remoteTeamUrl ? { remoteTeamUrl: config.remoteTeamUrl } : {}),
    tokenEnv: config.tokenEnv,
    tokenConfigured: config.mode === "remote-team"
      ? Boolean(process.env[config.tokenEnv]?.trim())
      : Boolean(process.env.PROJECT_CONTEXT_TEAM_UI_TOKEN?.trim()),
    summary,
  };
}

export function connectionIdentity(config: ConnectionConfig): string {
  return createHash("sha256").update(JSON.stringify([config.mode, config.remoteTeamUrl ?? "", config.tokenEnv])).digest("hex");
}

function normalizeConnection(config: ConnectionConfig): ConnectionConfig {
  if (config.mode === "remote-team") {
    if (!config.remoteTeamUrl) {
      throw new ProjectContextError("INVALID_CONNECTION_CONFIG", "Remote team mode is missing remoteTeamUrl.");
    }
    return {
      version: 1,
      mode: "remote-team",
      remoteTeamUrl: validateRemoteTeamUrl(config.remoteTeamUrl),
      tokenEnv: config.tokenEnv,
    };
  }
  return { version: 1, mode: "local", tokenEnv: config.tokenEnv };
}

export function validateRemoteTeamUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProjectContextError("INVALID_REMOTE_TEAM_URL", "Remote MCP URL must be an absolute http(s) URL ending with /mcp.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProjectContextError("INVALID_REMOTE_TEAM_URL", "Remote MCP URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ProjectContextError("INVALID_REMOTE_TEAM_URL", "Do not put credentials in the URL; use a Bearer token environment variable.");
  }
  if (url.search || url.hash) {
    throw new ProjectContextError("INVALID_REMOTE_TEAM_URL", "Remote MCP URL must not include query or fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!path.endsWith("/mcp")) {
    throw new ProjectContextError("INVALID_REMOTE_TEAM_URL", "Remote MCP URL path must end with /mcp.");
  }
  const host = url.hostname.toLowerCase();
  const loopbackOrPrivate = host === "localhost"
    || host === "127.0.0.1"
    || /^10\.\d+\.\d+\.\d+$/.test(host)
    || /^192\.168\.\d+\.\d+$/.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host);
  if (url.protocol === "http:" && !loopbackOrPrivate) {
    throw new ProjectContextError("INVALID_REMOTE_TEAM_URL", "Public hosts require https. Plain http is only allowed for localhost or private LAN addresses.");
  }
  return `${url.origin}${path}`;
}
