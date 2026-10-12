import { isAbsolute, normalize, resolve } from "node:path";
import { z } from "zod/v4";
import type { SqliteDatabase } from "../storage/database.js";
import { openDatabase } from "../storage/database.js";
import { migrateRegistry } from "../storage/schema.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import { createId, nowIso } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { isWithinRoot } from "../security/path-policy.js";
import { memoryStatusSchema, memoryTypeSchema } from "./memory-service.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { taskOverlap, taskTokens } from "../shared/task-relevance.js";

export const userMemoryScopeSchema = z.enum(["user", "workspace", "project", "module", "task"]);
export const userMemorySourceKindSchema = z.enum(["user", "tool", "inference", "import"]);

export interface UserMemoryRecord {
  id: string;
  type: z.infer<typeof memoryTypeSchema>;
  title: string;
  content: string;
  reason: string | null;
  status: z.infer<typeof memoryStatusSchema>;
  confidence: number;
  scopeLevel: z.infer<typeof userMemoryScopeSchema>;
  projectId: string | null;
  scopeRef: string | null;
  sourceKind: z.infer<typeof userMemorySourceKindSchema>;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserMemoryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  reason: string | null;
  status: string;
  confidence: number;
  scope_level: string;
  project_id: string | null;
  scope_ref: string | null;
  source_kind: string;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

export class UserMemoryService {
  private readonly db: SqliteDatabase;

  constructor(storageRoot: string) {
    this.db = openDatabase(resolve(storageRoot, "registry.db"));
    migrateRegistry(this.db);
  }

  remember(input: {
    type: z.infer<typeof memoryTypeSchema>;
    title: string;
    content: string;
    reason?: string;
    confidence?: number;
    scopeLevel?: z.infer<typeof userMemoryScopeSchema>;
    projectId?: string;
    scopeRef?: string;
    sourceKind: z.infer<typeof userMemorySourceKindSchema>;
    supersedesId?: string;
  }): UserMemoryRecord {
    const scopeLevel = input.scopeLevel ?? "user";
    const projectId = input.projectId?.trim() || null;
    let scopeRef = input.scopeRef?.trim() || null;
    validateScope(scopeLevel, projectId, scopeRef);
    if (scopeLevel === "workspace") scopeRef = normalize(resolve(scopeRef!));
    if (input.supersedesId) this.ensure(input.supersedesId);
    const timestamp = nowIso();
    const memory: UserMemoryRecord = {
      id: createId("umem"),
      type: input.type,
      title: input.title.trim(),
      content: input.content.trim(),
      reason: input.reason?.trim() || null,
      status: "active",
      confidence: input.confidence ?? (input.sourceKind === "inference" ? 0.5 : 0.9),
      scopeLevel,
      projectId,
      scopeRef,
      sourceKind: input.sourceKind,
      supersedesId: input.supersedesId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!memory.title || !memory.content) {
      throw new ProjectContextError("INVALID_USER_MEMORY", "User memory title and content are required.");
    }
    if (memory.confidence < 0 || memory.confidence > 1) {
      throw new ProjectContextError("INVALID_CONFIDENCE", "Confidence must be between 0 and 1.");
    }
    if (containsLikelySecret(`${memory.title}\n${memory.content}\n${memory.reason ?? ""}`)) {
      throw new ProjectContextError(
        "SENSITIVE_MEMORY_REJECTED",
        "User memory appears to contain a credential or private key and was not stored.",
      );
    }
    this.db.transaction(() => {
      if (memory.supersedesId) {
        this.db.prepare("UPDATE user_memories SET status = 'superseded', updated_at = ? WHERE id = ?")
          .run(timestamp, memory.supersedesId);
      }
      this.db.prepare(`
        INSERT INTO user_memories (
          id, type, title, content, reason, status, confidence, scope_level, project_id,
          scope_ref, source_kind, supersedes_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memory.id, memory.type, memory.title, memory.content, memory.reason, memory.status,
        memory.confidence, memory.scopeLevel, memory.projectId, memory.scopeRef,
        memory.sourceKind, memory.supersedesId, memory.createdAt, memory.updatedAt,
      );
    })();
    return memory;
  }

  list(status = "active", limit = 50): UserMemoryRecord[] {
    return (this.db.prepare(
      "SELECT * FROM user_memories WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
    ).all(status, limit) as UserMemoryRow[]).map(mapUserMemory);
  }

  listAll(limit = 500): UserMemoryRecord[] {
    return (this.db.prepare(
      "SELECT * FROM user_memories ORDER BY updated_at DESC LIMIT ?",
    ).all(limit) as UserMemoryRow[]).map(mapUserMemory);
  }

  get(memoryId: string): UserMemoryRecord {
    const row = this.db.prepare("SELECT * FROM user_memories WHERE id = ?").get(memoryId) as UserMemoryRow | undefined;
    if (!row) throw new ProjectContextError("USER_MEMORY_NOT_FOUND", `Unknown user memory: ${memoryId}`);
    return mapUserMemory(row);
  }

  updateStatus(memoryId: string, status: z.infer<typeof memoryStatusSchema>): UserMemoryRecord {
    this.ensure(memoryId);
    this.db.prepare("UPDATE user_memories SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), memoryId);
    return this.get(memoryId);
  }

  applicable(project: ProjectRecord, task: string, limit = 100): UserMemoryRecord[] {
    const loweredTask = task.toLowerCase();
    const terms = taskTokens(task);
    return this.list("active", 500).filter((memory) => {
      const text = `${memory.title} ${memory.content} ${memory.scopeRef ?? ""}`.normalize("NFKC").toLowerCase();
      if (memory.type === "task-summary" || taskOverlap(terms, text) === 0) return false;
      if (memory.scopeLevel === "user") return true;
      if (memory.scopeLevel === "workspace") {
        return memory.scopeRef !== null && isWithinRoot(memory.scopeRef, project.rootPath);
      }
      if (memory.projectId !== project.id) return false;
      if (memory.scopeLevel === "project") return true;
      return memory.scopeRef !== null && loweredTask.includes(memory.scopeRef.toLowerCase());
    }).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }

  private ensure(memoryId: string): void {
    this.get(memoryId);
  }
}

function validateScope(
  scopeLevel: z.infer<typeof userMemoryScopeSchema>,
  projectId: string | null,
  scopeRef: string | null,
): void {
  if (scopeLevel === "user" && (projectId || scopeRef)) {
    throw new ProjectContextError("INVALID_USER_MEMORY_SCOPE", "User scope cannot include projectId or scopeRef.");
  }
  if (scopeLevel === "workspace" && (!scopeRef || !isAbsolute(scopeRef) || projectId)) {
    throw new ProjectContextError(
      "INVALID_USER_MEMORY_SCOPE",
      "Workspace scope requires an absolute scopeRef and cannot include projectId.",
    );
  }
  if (scopeLevel === "project" && (!projectId || scopeRef)) {
    throw new ProjectContextError(
      "INVALID_USER_MEMORY_SCOPE",
      "Project scope requires projectId and cannot include scopeRef.",
    );
  }
  if ((scopeLevel === "module" || scopeLevel === "task") && (!projectId || !scopeRef)) {
    throw new ProjectContextError(
      "INVALID_USER_MEMORY_SCOPE",
      `${scopeLevel} scope requires both projectId and scopeRef.`,
    );
  }
}

function mapUserMemory(row: UserMemoryRow): UserMemoryRecord {
  return {
    id: row.id,
    type: memoryTypeSchema.parse(row.type),
    title: row.title,
    content: row.content,
    reason: row.reason,
    status: memoryStatusSchema.parse(row.status),
    confidence: row.confidence,
    scopeLevel: userMemoryScopeSchema.parse(row.scope_level),
    projectId: row.project_id,
    scopeRef: row.scope_ref,
    sourceKind: userMemorySourceKindSchema.parse(row.source_kind),
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
