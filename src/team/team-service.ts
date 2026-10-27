import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";
import { openDatabase, type SqliteDatabase } from "../storage/database.js";
import type { ProjectContextApp } from "../core/app.js";
import { ProjectContextError } from "../shared/errors.js";
import { memoryTypeSchema, type MemoryRecord } from "../memory/memory-service.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import { exportCodeGraph } from "../code-intelligence/graph-export.js";

export const teamRoleSchema = z.enum(["owner", "editor", "reviewer", "viewer"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;
export interface TeamPrincipal { userId: string; clientId: string; tokenId?: string; }
interface Share { id: string; workspace_id: string; project_id: string; name: string; types_json: string; require_reviewer: number; revoked_at: string | null; }
const memberId = z.string().min(1).max(200);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const now = () => new Date().toISOString();

export class TeamService {
  readonly db: SqliteDatabase;
  constructor(readonly app: ProjectContextApp) {
    this.db = openDatabase(join(app.storageRoot, "team.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_orgs(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_workspaces(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES team_orgs(id),name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_members(workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
      CREATE TABLE IF NOT EXISTS team_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,client_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS team_invites(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),user_id TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,accepted_at TEXT);
      CREATE TABLE IF NOT EXISTS team_shares(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),project_id TEXT NOT NULL,name TEXT NOT NULL,types_json TEXT NOT NULL,require_reviewer INTEGER NOT NULL DEFAULT 1,revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS team_audit(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,share_id TEXT,actor TEXT NOT NULL,client_id TEXT NOT NULL,action TEXT NOT NULL,entity_id TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT);
      CREATE INDEX IF NOT EXISTS team_audit_workspace ON team_audit(workspace_id,created_at);
      CREATE TABLE IF NOT EXISTS team_presence(share_id TEXT NOT NULL,task_id TEXT NOT NULL,user_id TEXT NOT NULL,client_id TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(share_id,task_id,user_id));
      CREATE TABLE IF NOT EXISTS team_code_shares(share_id TEXT PRIMARY KEY REFERENCES team_shares(id));
    `);
  }
  close() { this.db.close(); }

  /** Local operator bootstrap; intentionally not exposed as an unauthenticated network operation. */
  createWorkspace(orgName: string, workspaceName: string, ownerId: string) {
    z.string().trim().min(1).max(200).parse(orgName); z.string().trim().min(1).max(200).parse(workspaceName); memberId.parse(ownerId);
    return this.db.transaction(() => {
      const orgId = "org_" + randomUUID(), workspaceId = "ws_" + randomUUID();
      this.db.prepare("INSERT INTO team_orgs VALUES(?,?)").run(orgId, orgName);
      this.db.prepare("INSERT INTO team_workspaces VALUES(?,?,?)").run(workspaceId, orgId, workspaceName);
      this.db.prepare("INSERT INTO team_members VALUES(?,?, 'owner')").run(workspaceId, ownerId);
      this.audit({ userId: ownerId, clientId: "local-operator" }, workspaceId, null, "workspace.create", workspaceId, "completed");
      return { orgId, workspaceId, ownerId };
    }).immediate();
  }

  issueToken(userId: string, clientId: string, days = 30) {
    memberId.parse(userId); memberId.parse(clientId); z.number().int().min(1).max(90).parse(days);
    if (!this.db.prepare("SELECT 1 FROM team_members WHERE user_id=?").get(userId)) throw new ProjectContextError("TEAM_MEMBER_NOT_FOUND", "User has no active workspace membership.");
    const token = randomBytes(32).toString("base64url"); const id = "tok_" + randomUUID();
    const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO team_tokens VALUES(?,?,?,?,?,NULL)").run(id, userId, clientId, sha256(token), expiresAt);
      for(const workspace of this.db.prepare("SELECT workspace_id FROM team_members WHERE user_id=?").pluck().all(userId) as string[])
        this.audit({userId,clientId:"local-operator"},workspace,null,"token.issue",id,"completed");
    }).immediate();
    return { id, token, expiresAt };
  }
  revokeToken(id: string) {
    this.db.transaction(() => {
      const userId=this.db.prepare("SELECT user_id FROM team_tokens WHERE id=?").pluck().get(id) as string | undefined;
      this.db.prepare("UPDATE team_tokens SET revoked_at=? WHERE id=?").run(now(), id);
      if(userId)for(const workspace of this.db.prepare("SELECT workspace_id FROM team_members WHERE user_id=?").pluck().all(userId) as string[])
        this.audit({userId,clientId:"local-operator"},workspace,null,"token.revoke",id,"completed");
    }).immediate();
    return {id,revoked:true};
  }
  authenticate(token: string): TeamPrincipal {
    if (token.length < 32 || token.length > 4096) throw new ProjectContextError("TEAM_UNAUTHENTICATED", "Invalid or expired team credential.");
    const digest = sha256(token);
    const row = this.db.prepare("SELECT id,user_id,client_id,token_hash FROM team_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?").get(digest, now()) as
      { id: string; user_id: string; client_id: string; token_hash: string } | undefined;
    if (!row || !timingSafeEqual(Buffer.from(digest), Buffer.from(row.token_hash))) throw new ProjectContextError("TEAM_UNAUTHENTICATED", "Invalid or expired team credential.");
    return { userId: row.user_id, clientId: row.client_id, tokenId: row.id };
  }
  role(principal: TeamPrincipal, workspaceId: string): TeamRole {
    this.validatePrincipal(principal);
    const role = this.db.prepare("SELECT role FROM team_members WHERE workspace_id=? AND user_id=?").pluck().get(workspaceId, principal.userId);
    if (!role) throw new ProjectContextError("TEAM_FORBIDDEN", "Workspace membership is required.");
    return teamRoleSchema.parse(role);
  }
  private validatePrincipal(principal: TeamPrincipal) {
    if (principal.tokenId && !this.db.prepare("SELECT 1 FROM team_tokens WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?").get(principal.tokenId, principal.userId, now())) {
      throw new ProjectContextError("TEAM_UNAUTHENTICATED", "Team credential has expired or was revoked.");
    }
  }
  requireRole(principal: TeamPrincipal, workspaceId: string, roles: TeamRole[]) {
    const role = this.role(principal, workspaceId); if (!roles.includes(role)) throw new ProjectContextError("TEAM_FORBIDDEN", "This operation is not permitted by the workspace role."); return role;
  }
  invite(principal: TeamPrincipal, workspaceId: string, userId: string, role: TeamRole) {
    this.requireRole(principal, workspaceId, ["owner"]); memberId.parse(userId); teamRoleSchema.parse(role);
    const token = randomBytes(32).toString("base64url"); const id = "invite_" + randomUUID();
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO team_invites VALUES(?,?,?,?,?,?,NULL)").run(id, workspaceId, userId, role, sha256(token), expiresAt);
      this.audit(principal, workspaceId, null, "member.invite", userId, "completed");
    }).immediate();
    return { id, inviteToken: token, expiresAt };
  }
  acceptInvite(token: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM team_invites WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?").get(sha256(token), now()) as
        { id: string; workspace_id: string; user_id: string; role: TeamRole } | undefined;
      if (!row) throw new ProjectContextError("TEAM_INVITE_INVALID", "Invitation is invalid, expired or already accepted.");
      if (this.db.prepare("SELECT 1 FROM team_members WHERE workspace_id=? AND user_id=?").get(row.workspace_id, row.user_id)) throw new ProjectContextError("TEAM_MEMBER_EXISTS", "Existing member roles must be changed explicitly.");
      this.db.prepare("INSERT INTO team_members VALUES(?,?,?)").run(row.workspace_id, row.user_id, row.role);
      this.db.prepare("UPDATE team_invites SET accepted_at=? WHERE id=?").run(now(), row.id);
      this.audit({ userId: row.user_id, clientId: "invitation" }, row.workspace_id, null, "member.accept", row.user_id, "completed");
      return { workspaceId: row.workspace_id, userId: row.user_id, role: row.role };
    }).immediate();
  }
  setMember(principal: TeamPrincipal, workspaceId: string, userId: string, role: TeamRole | null) {
    return this.db.transaction(() => {
      this.requireRole(principal, workspaceId, ["owner"]); memberId.parse(userId); if (role) teamRoleSchema.parse(role);
      const current = this.db.prepare("SELECT role FROM team_members WHERE workspace_id=? AND user_id=?").pluck().get(workspaceId, userId);
      if (!current) throw new ProjectContextError("TEAM_MEMBER_NOT_FOUND", "Member does not exist.");
      if (current === "owner" && role !== "owner" && Number(this.db.prepare("SELECT COUNT(*) FROM team_members WHERE workspace_id=? AND role='owner'").pluck().get(workspaceId)) <= 1) {
        throw new ProjectContextError("TEAM_LAST_OWNER", "A workspace must retain an owner.");
      }
      if (role) this.db.prepare("UPDATE team_members SET role=? WHERE workspace_id=? AND user_id=?").run(role, workspaceId, userId);
      else {
        this.db.prepare("DELETE FROM team_members WHERE workspace_id=? AND user_id=?").run(workspaceId, userId);
        this.db.prepare("UPDATE team_invites SET expires_at=? WHERE workspace_id=? AND user_id=? AND accepted_at IS NULL").run(now(),workspaceId,userId);
      }
      this.audit(principal, workspaceId, null, role ? "member.role." + role : "member.remove", userId, "completed");
      return { userId, role };
    }).immediate();
  }
  share(principal: TeamPrincipal, workspaceId: string, projectId: string, options: { types?: string[]; requireReviewer?: boolean } = {}) {
    this.requireRole(principal, workspaceId, ["owner"]); const project = this.app.projects.get(projectId);
    const types = z.array(memoryTypeSchema).min(1).parse(options.types ?? ["decision", "constraint"]);
    const id = "share_" + randomUUID();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO team_shares VALUES(?,?,?,?,?,?,NULL)").run(id, workspaceId, projectId, project.name, JSON.stringify(types), options.requireReviewer === false ? 0 : 1);
      this.audit(principal, workspaceId, id, "project.share", projectId, "completed");
    }).immediate();
    return { shareId: id, workspaceId, name: project.name, types, requireReviewer: options.requireReviewer !== false };
  }
  access(principal: TeamPrincipal, shareId: string, roles?: TeamRole[]) {
    const share = this.db.prepare("SELECT * FROM team_shares WHERE id=? AND revoked_at IS NULL").get(shareId) as Share | undefined;
    if (!share) throw new ProjectContextError("TEAM_SHARE_NOT_FOUND", "Shared project is unavailable.");
    const role = roles ? this.requireRole(principal, share.workspace_id, roles) : this.role(principal, share.workspace_id);
    return { share, role, types: JSON.parse(share.types_json) as string[] };
  }
  revokeShare(principal: TeamPrincipal, shareId: string) {
    const { share } = this.access(principal, shareId, ["owner"]);
    this.db.transaction(() => { this.db.prepare("UPDATE team_shares SET revoked_at=? WHERE id=?").run(now(), shareId); this.audit(principal, share.workspace_id, shareId, "project.revoke", shareId, "completed"); })();
    return { shareId, revoked: true };
  }
  listShares(principal: TeamPrincipal) {
    this.validatePrincipal(principal);
    return this.db.prepare("SELECT s.id AS shareId,s.name,s.workspace_id AS workspaceId,m.role,s.require_reviewer AS requireReviewer,EXISTS(SELECT 1 FROM team_code_shares c WHERE c.share_id=s.id) AS codeGraphEnabled FROM team_shares s JOIN team_members m ON m.workspace_id=s.workspace_id WHERE m.user_id=? AND s.revoked_at IS NULL ORDER BY s.name LIMIT 200").all(principal.userId);
  }
  configureCodeGraph(principal: TeamPrincipal, shareId: string, enabled: boolean) {
    const {share} = this.access(principal, shareId, ["owner"]);
    this.db.transaction(() => {
      if(enabled) this.db.prepare("INSERT OR IGNORE INTO team_code_shares VALUES(?)").run(shareId);
      else this.db.prepare("DELETE FROM team_code_shares WHERE share_id=?").run(shareId);
      this.audit(principal,share.workspace_id,shareId,enabled ? "code.share" : "code.revoke",shareId,"completed");
    }).immediate();
    return {shareId,enabled};
  }
  codeGraph(principal: TeamPrincipal, shareId: string) {
    const {share} = this.access(principal,shareId);
    if(!this.db.prepare("SELECT 1 FROM team_code_shares WHERE share_id=?").get(shareId)) throw new ProjectContextError("TEAM_CODE_NOT_SHARED","Code metadata has not been explicitly shared.");
    const db=this.app.projects.projectDatabase(share.project_id);
    try {return exportCodeGraph(db);} finally {db.close();}
  }
  memories(principal: TeamPrincipal, shareId: string, query = "", limit = 50) {
    const { share, types } = this.access(principal, shareId);
    const db = this.app.projects.projectDatabase(share.project_id);
    try { return db.prepare(`SELECT id,type,title,content,status,updated_at AS updatedAt FROM memories WHERE status='active' AND type IN (${types.map(() => "?").join(",")}) AND (?='' OR instr(lower(title || ' ' || content),lower(?))>0) ORDER BY updated_at DESC LIMIT ?`)
      .all(...types, query, query, Math.max(1, Math.min(100, limit))); } finally { db.close(); }
  }
  candidates(principal: TeamPrincipal, shareId: string) {
    const { share, types } = this.access(principal, shareId, ["owner", "editor", "reviewer"]);
    return this.app.candidates(share.project_id).filter(candidate => types.includes(candidate.type));
  }
  propose(principal: TeamPrincipal, shareId: string, input: { type: string; title: string; content: string }) {
    const { share, types } = this.access(principal, shareId, ["owner", "editor", "reviewer"]);
    const type = memoryTypeSchema.parse(input.type);
    if (!types.includes(type)) throw new ProjectContextError("TEAM_SCOPE_FORBIDDEN", "This memory type is not shared.");
    const title = z.string().trim().min(1).max(500).parse(input.title); const content = z.string().trim().min(1).max(32000).parse(input.content);
    if (containsLikelySecret(title + "\n" + content)) throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Proposal contains a suspected credential or private key.");
    const id = "cand_" + randomUUID();
    return this.audited(principal, share, "candidate.propose", id, () => {
      const db = this.app.projects.projectDatabase(share.project_id);
      const timestamp = now();
      try {
        db.prepare(`INSERT INTO memory_candidates(id,type,title,content,reason,confidence,scope_json,source_kind,source_ref,evidence_json,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,0.9,'[]','user',?,?,?,'pending',?,?)`)
          .run(id, type, title, content, "Proposed through an authenticated team endpoint.", "team:" + share.id,
            JSON.stringify({ actor: principal.userId, client: principal.clientId, shareId }), sha256(id), timestamp, timestamp);
        return { id, status: "pending" };
      } finally { db.close(); }
    });
  }
  accept(principal: TeamPrincipal, shareId: string, candidateId: string): MemoryRecord {
    const { share, role, types } = this.access(principal, shareId, ["owner", "reviewer", "editor"]);
    if (share.require_reviewer && role === "editor") throw new ProjectContextError("TEAM_REVIEWER_REQUIRED", "A reviewer or owner must accept this candidate.");
    const candidate = this.app.candidates(share.project_id, "pending", 10000).find(candidate => candidate.id === candidateId);
    if (!candidate || !types.includes(candidate.type)) throw new ProjectContextError("TEAM_CANDIDATE_NOT_FOUND", "Candidate is unavailable in this share.");
    return this.audited(principal, share, "candidate.accept", candidateId, () => this.app.acceptCandidate(share.project_id, candidateId));
  }
  conflicts(principal: TeamPrincipal, shareId: string) {
    const { share, types } = this.access(principal, shareId, ["owner", "reviewer"]);
    if (!this.app.syncStatus(share.project_id).configured) return [];
    return this.app.syncConflicts(share.project_id).filter(conflict => conflict.table === "memories"
      && conflict.versions.some(version => version.operation === "put")
      && conflict.versions.every(version => version.operation === "delete" || types.includes(String((version.payload as Record<string, unknown>).type))));
  }
  async resolve(principal: TeamPrincipal, shareId: string, entity: string, eventId: string) {
    const { share } = this.access(principal, shareId, ["owner", "reviewer"]);
    if (!this.conflicts(principal, shareId).some(conflict => conflict.entity === entity && conflict.versions.some(event => event.id === eventId))) throw new ProjectContextError("TEAM_CONFLICT_NOT_FOUND", "Conflict version is unavailable in this share.");
    const auditId = this.audit(principal, share.workspace_id, shareId, "conflict.resolve", entity, "started");
    try { const result = await this.app.resolveSyncConflict(share.project_id, "memories", entity, eventId); this.finishAudit(auditId, "completed"); return result; }
    catch (error) { this.finishAudit(auditId, "failed"); throw error; }
  }
  presence(principal: TeamPrincipal, shareId: string, taskId?: string, ttlSeconds = 120) {
    const { share } = this.access(principal, shareId, taskId ? ["owner", "editor", "reviewer"] : undefined);
    if (taskId) {
      z.number().int().min(0).max(300).parse(ttlSeconds); this.app.taskHistory(share.project_id, taskId, { limit: 1 });
      if (!ttlSeconds) this.db.prepare("DELETE FROM team_presence WHERE share_id=? AND task_id=? AND user_id=?").run(shareId, taskId, principal.userId);
      else this.db.prepare("INSERT INTO team_presence VALUES(?,?,?,?,?) ON CONFLICT(share_id,task_id,user_id) DO UPDATE SET client_id=excluded.client_id,expires_at=excluded.expires_at")
        .run(shareId, taskId, principal.userId, principal.clientId, new Date(Date.now() + ttlSeconds * 1000).toISOString());
    }
    return this.db.prepare("SELECT task_id AS taskId,user_id AS userId,client_id AS clientId,expires_at AS expiresAt FROM team_presence WHERE share_id=? AND expires_at>?").all(shareId, now());
  }
  auditLog(principal: TeamPrincipal, shareId: string, offset = 0) {
    const { share } = this.access(principal, shareId, ["owner", "reviewer"]);
    z.number().int().min(0).max(10000000).parse(offset);
    return this.db.prepare("SELECT * FROM team_audit WHERE workspace_id=? AND (share_id=? OR share_id IS NULL) ORDER BY created_at ASC,id ASC LIMIT 1000 OFFSET ?").all(share.workspace_id, shareId, offset);
  }
  private audited<T>(principal: TeamPrincipal, share: Share, action: string, entity: string | null, work: () => T): T {
    const id = this.audit(principal, share.workspace_id, share.id, action, entity, "started");
    try { const result = work(); this.finishAudit(id, "completed"); return result; }
    catch (error) { this.finishAudit(id, "failed"); throw error; }
  }
  private audit(principal: TeamPrincipal, workspaceId: string, shareId: string | null, action: string, entity: string | null, status: string) {
    const id = "audit_" + randomUUID(); this.db.prepare("INSERT INTO team_audit VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, workspaceId, shareId, principal.userId, principal.clientId, action, entity, status, now(), status === "completed" ? now() : null); return id;
  }
  private finishAudit(id: string, status: string) { this.db.prepare("UPDATE team_audit SET status=?,completed_at=? WHERE id=?").run(status, now(), id); }
}
