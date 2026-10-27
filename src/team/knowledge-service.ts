import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { TeamService, type TeamPrincipal } from "./team-service.js";
import { ProjectContextError } from "../shared/errors.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import type { SqliteDatabase } from "../storage/database.js";
import { startTask, getTask, checkpointTask, completeTask, cancelTask, listTaskHistory } from "../tasks/task-service.js";

const text = z.string().max(8000);
export const sharedCheckpointSchema = z.object({
  summary: text.optional(), completed: z.array(text).max(100).default([]), next: z.array(text).max(100).default([]),
  changedFiles: z.array(text).max(100).default([]), blockers: z.array(text).max(100).default([]), risks: z.array(text).max(100).default([]),
  verification: z.array(z.object({ command: text, status: text, summary: text.optional() }).strict()).max(100).default([]),
}).strict();
const writeRoles = ["owner", "editor", "reviewer"] as const;
type SharedRule = { id: string; shareId: string; title: string; content: string; version: number; status: "active" | "deleted"; updatedBy: string; updatedAt: string };

/** Shared knowledge is addressed by shareId, never by a developer's local path. */
export class TeamKnowledgeService {
  constructor(readonly team: TeamService) {
    team.db.exec("CREATE TABLE IF NOT EXISTS team_rules(id TEXT PRIMARY KEY,share_id TEXT NOT NULL REFERENCES team_shares(id),title TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);");
    team.db.exec("CREATE INDEX IF NOT EXISTS team_rules_share ON team_rules(share_id,status,updated_at);");
    team.db.exec("CREATE TABLE IF NOT EXISTS team_rule_history(rule_id TEXT NOT NULL REFERENCES team_rules(id),version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(rule_id,version));");
  }
  private safe(value: unknown) {
    if (containsLikelySecret(JSON.stringify(value))) throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Shared content contains a suspected credential or private key.");
  }
  private conflict() { throw new ProjectContextError("TEAM_VERSION_CONFLICT", "Shared content changed. Read the latest version before updating it."); }
  private taskDb<T>(principal: TeamPrincipal, shareId: string, write: boolean, work: (db: SqliteDatabase) => T): T {
    const { share } = this.team.access(principal, shareId, write ? [...writeRoles] : undefined);
    const db = this.team.app.projects.projectDatabase(share.project_id);
    try {
      // Existing local tasks stay private. Only explicitly created team tasks are shared.
      db.exec("CREATE TABLE IF NOT EXISTS team_task_links(share_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(share_id,task_id))");
      return work(db);
    } finally { db.close(); }
  }
  private taskValue(db: SqliteDatabase, shareId: string, taskId: string) {
    if (!db.prepare("SELECT 1 FROM team_task_links WHERE share_id=? AND task_id=?").get(shareId, taskId)) {
      throw new ProjectContextError("TEAM_TASK_NOT_FOUND", "Task is unavailable in this shared project.");
    }
    const version = Number(db.prepare("SELECT MAX(sequence) FROM task_events WHERE task_id=?").pluck().get(taskId));
    return { ...getTask(db, taskId), shareId, version };
  }
  tasks(principal: TeamPrincipal, shareId: string, status: "in_progress" | "completed" | "cancelled" = "in_progress", limit = 20, offset = 0) {
    z.enum(["in_progress", "completed", "cancelled"]).parse(status); this.page(limit, offset);
    return this.taskDb(principal, shareId, false, db => db.transaction(() => {
      const ids = db.prepare("SELECT t.id FROM tasks t JOIN team_task_links l ON l.task_id=t.id WHERE l.share_id=? AND t.status=? ORDER BY t.updated_at DESC,t.id LIMIT ? OFFSET ?").pluck().all(shareId, status, limit, offset) as string[];
      const total = Number(db.prepare("SELECT COUNT(*) FROM tasks t JOIN team_task_links l ON l.task_id=t.id WHERE l.share_id=? AND t.status=?").pluck().get(shareId, status));
      return { items: ids.map(id => this.taskValue(db, shareId, id)), total, limit, offset };
    })());
  }
  task(principal: TeamPrincipal, shareId: string, taskId: string) {
    return this.taskDb(principal, shareId, false, db => db.transaction(() => this.taskValue(db, shareId, taskId))());
  }
  taskHistory(principal: TeamPrincipal, shareId: string, taskId: string, limit = 20, offset = 0) {
    this.page(limit, offset);
    return this.taskDb(principal, shareId, false, db => { this.taskValue(db, shareId, taskId); return listTaskHistory(db, taskId, { limit, offset }); });
  }
  startTask(principal: TeamPrincipal, shareId: string, goal: string) {
    goal = z.string().trim().min(1).max(8000).parse(goal); this.safe(goal);
    const { share } = this.team.access(principal, shareId, [...writeRoles]);
    return this.team.audited(principal, share, "task.start", null, () => this.taskDb(principal, shareId, true, db => db.transaction(() => {
      const task = startTask(db, goal, { source: "team" });
      db.prepare("INSERT INTO team_task_links VALUES(?,?)").run(shareId, task.id);
      return this.taskValue(db, shareId, task.id);
    }).immediate()));
  }
  checkpoint(principal: TeamPrincipal, shareId: string, taskId: string, expectedVersion: number, requestId: string, input: z.input<typeof sharedCheckpointSchema>) {
    const checkpoint = sharedCheckpointSchema.parse(input); this.safe(checkpoint); this.version(expectedVersion);
    z.string().min(1).max(128).parse(requestId);
    const scopedRequest = "team:" + createHash("sha256").update(JSON.stringify([shareId, principal.userId, principal.clientId, requestId])).digest("hex");
    const { share } = this.team.access(principal, shareId, [...writeRoles]);
    return this.team.audited(principal, share, "task.checkpoint", taskId, () => this.taskDb(principal, shareId, true, db => db.transaction(() => {
      const current = this.taskValue(db, shareId, taskId);
      if (!db.prepare("SELECT 1 FROM task_checkpoint_requests WHERE task_id=? AND request_id=?").get(taskId, scopedRequest)) {
        if (current.version !== expectedVersion) this.conflict();
        if (current.status !== "in_progress") throw new ProjectContextError("TASK_TRANSITION_BLOCKED", "A finished shared task cannot be edited.");
      }
      checkpointTask(db, taskId, {
        completed: checkpoint.completed, next: checkpoint.next, changedFiles: checkpoint.changedFiles,
        blockers: checkpoint.blockers, risks: checkpoint.risks,
        ...(checkpoint.summary !== undefined ? { summary: checkpoint.summary } : {}),
        verification: checkpoint.verification.map(item => ({ command: item.command, status: item.status, ...(item.summary !== undefined ? { summary: item.summary } : {}) })),
      }, { requestId: scopedRequest, source: "team" });
      return this.taskValue(db, shareId, taskId);
    }).immediate()));
  }
  finishTask(principal: TeamPrincipal, shareId: string, taskId: string, expectedVersion: number, status: "completed" | "cancelled") {
    this.version(expectedVersion); z.enum(["completed", "cancelled"]).parse(status);
    const { share } = this.team.access(principal, shareId, [...writeRoles]);
    return this.team.audited(principal, share, "task." + status, taskId, () => this.taskDb(principal, shareId, true, db => db.transaction(() => {
      const current = this.taskValue(db, shareId, taskId);
      if (current.status === status) return current;
      if (current.version !== expectedVersion) this.conflict();
      if (status === "completed") completeTask(db, taskId, undefined, { source: "team" });
      else cancelTask(db, taskId, { source: "team" });
      return this.taskValue(db, shareId, taskId);
    }).immediate()));
  }
  rules(principal: TeamPrincipal, shareId: string, status: "active" | "deleted" = "active", limit = 20, offset = 0) {
    this.team.access(principal, shareId); z.enum(["active", "deleted"]).parse(status); this.page(limit, offset);
    return this.team.db.transaction(() => ({
      items: this.team.db.prepare("SELECT id,share_id AS shareId,title,content,version,status,updated_by AS updatedBy,updated_at AS updatedAt FROM team_rules WHERE share_id=? AND status=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?").all(shareId, status, limit, offset) as SharedRule[],
      total: Number(this.team.db.prepare("SELECT COUNT(*) FROM team_rules WHERE share_id=? AND status=?").pluck().get(shareId, status)), limit, offset,
    }))();
  }
  private rule(shareId: string, id: string): SharedRule {
    const row = this.team.db.prepare("SELECT id,share_id AS shareId,title,content,version,status,updated_by AS updatedBy,updated_at AS updatedAt FROM team_rules WHERE share_id=? AND id=?").get(shareId, id) as SharedRule | undefined;
    if (!row) throw new ProjectContextError("TEAM_RULE_NOT_FOUND", "Rule is unavailable in this shared project.");
    return row;
  }
  putRule(principal: TeamPrincipal, shareId: string, input: { title: string; content: string; ruleId?: string; expectedVersion?: number }) {
    const { share } = this.team.access(principal, shareId, ["owner", "reviewer"]);
    const title = z.string().trim().min(1).max(500).parse(input.title), content = z.string().trim().min(1).max(16000).parse(input.content); this.safe({ title, content });
    const id = input.ruleId ?? "rule_" + randomUUID();
    return this.team.audited(principal, share, "rule.put", id, () => this.team.db.transaction(() => {
      let version = 1;
      if (input.ruleId) {
        const current = this.rule(shareId, input.ruleId);
        if (current.version !== input.expectedVersion) this.conflict(); version = current.version + 1;
      } else if (input.expectedVersion !== undefined) throw new ProjectContextError("TEAM_RULE_INPUT", "New rules do not accept expectedVersion.");
      this.team.db.prepare("INSERT INTO team_rules VALUES(?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,version=excluded.version,status='active',updated_by=excluded.updated_by,updated_at=excluded.updated_at")
        .run(id, shareId, title, content, version, principal.userId, new Date().toISOString());
      const result = this.rule(shareId, id); this.team.db.prepare("INSERT INTO team_rule_history VALUES(?,?,?)").run(id, version, JSON.stringify(result)); return result;
    }).immediate());
  }
  disableRule(principal: TeamPrincipal, shareId: string, ruleId: string, expectedVersion: number) {
    const { share } = this.team.access(principal, shareId, ["owner", "reviewer"]); this.version(expectedVersion);
    return this.team.audited(principal, share, "rule.disable", ruleId, () => this.team.db.transaction(() => {
      const current = this.rule(shareId, ruleId); if (current.status === "deleted") return current;
      if (current.version !== expectedVersion) this.conflict();
      this.team.db.prepare("UPDATE team_rules SET status='deleted',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(principal.userId, new Date().toISOString(), ruleId);
      const result = this.rule(shareId, ruleId); this.team.db.prepare("INSERT INTO team_rule_history VALUES(?,?,?)").run(ruleId, result.version, JSON.stringify(result)); return result;
    }).immediate());
  }
  ruleHistory(principal: TeamPrincipal, shareId: string, ruleId: string, limit = 20, offset = 0) {
    this.team.access(principal, shareId); this.rule(shareId, ruleId); this.page(limit, offset);
    const db = this.team.db;
    return db.transaction(() => ({ items: (db.prepare("SELECT snapshot_json FROM team_rule_history WHERE rule_id=? ORDER BY version DESC LIMIT ? OFFSET ?").pluck().all(ruleId, limit, offset) as string[]).map(item => JSON.parse(item) as SharedRule),
      total: Number(db.prepare("SELECT COUNT(*) FROM team_rule_history WHERE rule_id=?").pluck().get(ruleId)), limit, offset }))();
  }
  context(principal: TeamPrincipal, shareId: string, query: string) {
    this.team.access(principal, shareId); z.string().max(500).parse(query);
    return { shareId, dataLocation: "server", sourceCodeIncluded: false,
      memories: this.team.memories(principal, shareId, query, 20), rules: this.rules(principal, shareId, "active", 50), tasks: this.tasks(principal, shareId, "in_progress", 20),
      note: "Shared project knowledge. Read local code and personal rules separately; lists are bounded and can be paged with the dedicated tools." };
  }
  private version(value: number) { z.number().int().min(1).parse(value); }
  private page(limit: number, offset: number) { z.number().int().min(1).max(100).parse(limit); z.number().int().min(0).max(100000).parse(offset); }
}
