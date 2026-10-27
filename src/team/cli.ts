import { Command, Option } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProjectContextApp } from "../core/app.js";
import { authorizeExistingPath, authorizeOutputPath } from "../security/path-policy.js";
import { TeamService, teamRoleSchema, type TeamRole } from "./team-service.js";
import { startTeamHttp } from "../mcp/http.js";

export function registerTeamCli(program: Command) {
  const team = program.command("team").description("Local operator administration of a self-hosted team service");
  const run = <T extends unknown[]>(work: (service: TeamService, ...args: T) => unknown | Promise<unknown>) => async (...args: T) => {
    const app = await ProjectContextApp.create(); const service = new TeamService(app);
    try { console.log(JSON.stringify(await work(service, ...args), null, 2)); } finally { service.close(); app.close(); }
  };
  team.command("init").requiredOption("--org <name>").requiredOption("--workspace <name>").requiredOption("--owner <user-id>")
    .action(run((service, options: { org: string; workspace: string; owner: string }) => service.createWorkspace(options.org, options.workspace, options.owner)));
  team.command("token").argument("<user-id>").requiredOption("--client <client-id>").requiredOption("--output <absolute-path>", "new protected credential file; token is never printed")
    .action(run(async (service, userId: string, options: { client: string; output: string }) => {
      const path = await authorizeOutputPath(options.output, service.app.allowedOutputRoots); await mkdir(dirname(path), { recursive: true });
      const result = service.issueToken(userId, options.client);
      try { await writeFile(path, result.token + "\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { service.revokeToken(result.id); throw error; }
      return { id: result.id, expiresAt: result.expiresAt, credentialFile: path };
    }));
  team.command("revoke-token").argument("<token-id>").action(run((service, id: string) => service.revokeToken(id)));
  team.command("invite").argument("<workspace-id>").argument("<user-id>").requiredOption("--actor <owner-id>")
    .addOption(new Option("--role <role>").choices(teamRoleSchema.options).makeOptionMandatory())
    .requiredOption("--output <absolute-path>", "new invitation file")
    .action(run(async (service, workspaceId: string, userId: string, options: { actor: string; role: TeamRole; output: string }) => {
      const path = await authorizeOutputPath(options.output, service.app.allowedOutputRoots); await mkdir(dirname(path), { recursive: true });
      const result = service.invite({ userId: options.actor, clientId: "local-operator" }, workspaceId, userId, options.role);
      try { await writeFile(path, result.inviteToken + "\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { service.db.prepare("UPDATE team_invites SET expires_at=? WHERE id=?").run(new Date(0).toISOString(), result.id); throw error; }
      return { id: result.id, expiresAt: result.expiresAt, invitationFile: path };
    }));
  team.command("accept-invite").argument("<invitation-file>").action(run(async (service, source: string) => {
    const path = await authorizeExistingPath(source, service.app.allowedOutputRoots, "TEAM_INVITE_PATH", "Invitation");
    return service.acceptInvite((await readFile(path, "utf8")).trim());
  }));
  team.command("member").argument("<workspace-id>").argument("<user-id>").requiredOption("--actor <owner-id>")
    .addOption(new Option("--role <role>").choices([...teamRoleSchema.options, "removed"]).makeOptionMandatory())
    .action(run((service, workspaceId: string, userId: string, options: { actor: string; role: TeamRole | "removed" }) => service.setMember({ userId: options.actor, clientId: "local-operator" }, workspaceId, userId, options.role === "removed" ? null : options.role)));
  team.command("share").argument("<workspace-id>").argument("<project-id>").requiredOption("--actor <owner-id>")
    .option("--types <types...>", "shared memory types, default decision constraint").option("--allow-editor-review", "allow editors to accept candidates", false)
    .action(run((service, workspaceId: string, projectId: string, options: { actor: string; types?: string[]; allowEditorReview: boolean }) => service.share({ userId: options.actor, clientId: "local-operator" }, workspaceId, projectId,
      { requireReviewer: !options.allowEditorReview, ...(options.types ? { types: options.types } : {}) })));
  team.command("revoke-share").argument("<share-id>").requiredOption("--actor <owner-id>")
    .action(run((service, shareId: string, options: { actor: string }) => service.revokeShare({ userId: options.actor, clientId: "local-operator" }, shareId)));
  team.command("serve").option("--port <number>", "loopback HTTP MCP port", value => Number(value), 0)
    .action(async (options: { port: number }) => {
      const endpoint = await startTeamHttp(options); console.log(JSON.stringify({ url: endpoint.url, authentication: "Bearer", exposure: "loopback; use a trusted TLS reverse proxy for remote access" }));
      process.once("SIGINT", () => { void endpoint.close(); }); process.once("SIGTERM", () => { void endpoint.close(); });
    });
  team.command("code-sharing").argument("<share-id>").requiredOption("--actor <owner-id>")
    .addOption(new Option("--enabled <value>").choices(["true","false"]).makeOptionMandatory())
    .action(run((service,shareId:string,options:{actor:string;enabled:string}) => service.configureCodeGraph({userId:options.actor,clientId:"local-operator"},shareId,options.enabled==="true")));
}
