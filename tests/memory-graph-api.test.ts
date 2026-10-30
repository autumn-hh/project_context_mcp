import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer, type UiServerHandle } from "../src/ui/server.js";

describe("local memory graph HTTP boundaries", () => {
  let temp: string;
  let app: ProjectContextApp;
  let ui: UiServerHandle;
  let previous: Record<string, string | undefined>;
  let projectId: string;
  let otherId: string;
  let currentId: string;
  let oldId: string;
  let cookie: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "memory-graph-api-"));
    previous = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
    };
    process.env.PROJECT_CONTEXT_HOME = join(temp, "storage");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = temp;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = temp;
    const root = join(temp, "project");
    await mkdir(root);
    await mkdir(join(temp, "other"));
    await writeFile(join(root, "README.md"), "Policy: Store local project knowledge.\n");
    app = await ProjectContextApp.create();
    const project = await app.openProject(root);
    projectId = project.id;
    otherId = (await app.openProject(join(temp, "other"))).id;
    await app.index(projectId);
    oldId = app.remember(projectId, {
      type: "decision", title: "Old storage", content: "Use a previous snapshot.",
      sourceKind: "file", sourceRef: "README.md:1",
    }).id;
    currentId = app.remember(projectId, {
      type: "decision", title: "Storage policy", content: "Store local project knowledge.",
      sourceKind: "file", sourceRef: "README.md:1", supersedesId: oldId, scope: ["src/storage"],
    }).id;
    ui = await startUiServer({ openBrowser: false });
    const token = new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token");
    const session = await fetch(`${ui.url}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ui.url, "X-Project-Context-UI": "1" },
      body: JSON.stringify({ token }),
    });
    cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await ui?.close();
    app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  });

  const request = (path: string, authenticated = true, origin?: string) => fetch(`${ui.url}${path}`, {
    headers: { Origin: origin ?? ui.url, "X-Project-Context-UI": "1", ...(authenticated ? { Cookie: cookie } : {}) },
  });

  it("serves a graph, source evidence and opt-in history without crossing projects", async () => {
    const path = `/api/projects/${projectId}/memory-graph`;
    const knowledge = await (await request(path)).json();
    expect(knowledge.view).toBe("knowledge");
    expect(knowledge.nodes.every((entry: { nodeType: string }) => entry.nodeType === "memory")).toBe(true);
    expect(knowledge.totals.memories).toBe(1);
    const response = await request(path + "?view=evidence");
    expect(response.status).toBe(200);
    const graph = await response.json();
    expect(graph.nodes.some((node: { id: string }) => node.id === `memory:${currentId}`)).toBe(true);
    expect(graph.nodes.some((node: { id: string }) => node.id === `memory:${oldId}`)).toBe(false);
    const source = graph.nodes.find((node: { nodeType: string }) => node.nodeType === "source");
    const details = await (await request(`${path}/nodes/${encodeURIComponent(source.id)}`)).json();
    expect(details.source).toMatchObject({ sourceRef: "README.md:1", startLine: 1, missing: false });
    expect(details.source.excerpt).toContain("Store local project knowledge");
    const history = await (await request(`${path}?includeInactive=true&node=${encodeURIComponent(`memory:${currentId}`)}&depth=2`)).json();
    expect(history.edges.some((edge: { relationType: string }) => edge.relationType === "SUPERSEDES")).toBe(true);
    expect((await request(`${path}/nodes/${encodeURIComponent(`memory:${oldId}`)}`)).status).toBe(404);
    expect((await request(`/api/projects/${otherId}/memory-graph/nodes/${encodeURIComponent(`memory:${currentId}`)}`)).status).toBe(404);
    const hiddenEdges = await (await request(`${path}?relation=none`)).json();
    expect(hiddenEdges.edges).toEqual([]);
    expect(hiddenEdges.nodes.length).toBeGreaterThan(0);
  });

  it("requires the existing session and rejects invalid graph inputs", async () => {
    const path = `/api/projects/${projectId}/memory-graph`;
    expect((await request(path, false)).status).toBe(401);
    expect((await request(path, true, "https://other.invalid")).status).toBe(403);
    for (const suffix of ["?view=unknown", "?includeSummaries=yes", "?depth=3", "?limit=151", "?limit=NaN", "?includeInactive=yes", "?relation=INVENTED", "?relation=none&relation=SUPERSEDES", `?query=${"a".repeat(201)}`]) {
      expect((await request(path + suffix)).status).toBe(400);
    }
    expect((await request(`${path}/nodes/${encodeURIComponent("scope:not-base64")}`)).status).toBe(400);
    expect(app.memories(projectId, "active", 100).map((memory) => memory.id)).toEqual([currentId]);
    expect(app.memories(projectId, "superseded", 100).map((memory) => memory.id)).toEqual([oldId]);
  });
});
