import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectContextApp } from "../src/core/app.js";
import { TeamService } from "../src/team/team-service.js";
import { startTeamHttp } from "../src/mcp/http.js";
import { startUiServer } from "../src/ui/server.js";
import {
  connectionFilePath,
  saveConnectionConfig,
  validateRemoteTeamUrl,
} from "../src/config/connection.js";

describe("opt-in remote MCP connection config", () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let previousAppData: string | undefined;
  let configHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "connection-test-"));
    configHome = join(root, "config");
    await mkdir(configHome, { recursive: true });
    previousAppData = process.env.APPDATA;
    process.env.APPDATA = configHome;
    const values = {
      PROJECT_CONTEXT_HOME: join(root, "store"),
      PROJECT_CONTEXT_ALLOWED_ROOTS: root,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: root,
      PROJECT_CONTEXT_TEAM_UI_TOKEN: "",
      PROJECT_CONTEXT_TEAM_TOKEN: "",
    };
    env = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to local and rejects public http URLs", async () => {
    const local = await saveConnectionConfig({ mode: "local" });
    expect(local.mode).toBe("local");
    expect(local.tokenConfigured).toBe(false);
    expect(connectionFilePath()).toContain(join("project-context", "connection.json"));
    expect(() => validateRemoteTeamUrl("http://example.com/mcp")).toThrow(/https/);
    expect(validateRemoteTeamUrl("http://192.168.1.8:8787/mcp/")).toBe("http://192.168.1.8:8787/mcp");
    expect(validateRemoteTeamUrl("https://team.example.com/mcp")).toBe("https://team.example.com/mcp");
  });

  it("lets the UI team review talk to a remote team MCP when opted in", async () => {
    const app = await ProjectContextApp.create();
    await mkdir(join(root, "project"));
    const projectId = (await app.openProject(join(root, "project"))).id;
    app.remember(projectId, { type: "constraint", title: "远程约束", content: "from remote db", sourceKind: "user" });
    const team = new TeamService(app);
    const workspaceId = team.createWorkspace("Org", "Workspace", "owner").workspaceId;
    const shareId = team.share({ userId: "owner", clientId: "local" }, workspaceId, projectId).shareId;
    const invitation = team.invite({ userId: "owner", clientId: "local" }, workspaceId, "reviewer", "reviewer");
    team.acceptInvite(invitation.inviteToken);
    const credential = team.issueToken("reviewer", "ui");
    process.env.PROJECT_CONTEXT_TEAM_TOKEN = credential.token;
    const endpoint = await startTeamHttp();
    await saveConnectionConfig({ mode: "remote-team", remoteTeamUrl: endpoint.url, tokenEnv: "PROJECT_CONTEXT_TEAM_TOKEN" });

    const ui = await startUiServer({ openBrowser: false });
    let cookie = "";
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(ui.url + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: ui.url,
          "X-Project-Context-UI": "1",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { response, body: await response.json() };
    };
    try {
      expect((await request("/api/connection")).response.status).toBe(401);
      expect((await request("/api/team")).response.status).toBe(401);
      const session = await request("/api/session", {
        token: new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token"),
      });
      cookie = session.response.headers.get("set-cookie")!.split(";")[0]!;

      const status = await request("/api/connection");
      expect(status.response.status).toBe(200);
      expect(status.body.mode).toBe("remote-team");
      expect(JSON.stringify(status.body)).not.toContain(credential.token);

      const shares = await request("/api/team");
      expect(shares.response.status).toBe(200);
      expect(JSON.stringify(shares.body)).toContain(shareId);
      expect(JSON.stringify(shares.body)).not.toContain(credential.token);

      // sanity: the same remote endpoint answers MCP clients directly
      const client = new Client({ name: "fixture", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
        }));
        const search = await client.callTool({ name: "team_search", arguments: { shareId } });
        expect(JSON.stringify(search)).toContain("from remote db");
      } finally {
        await client.close();
      }

      await saveConnectionConfig({ mode: "local" });
      expect((await request("/api/connection")).body.mode).toBe("local");
    } finally {
      await ui.close();
      await endpoint.close();
      team.close();
      app.close();
    }
  });
});
