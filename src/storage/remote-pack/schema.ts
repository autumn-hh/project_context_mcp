import { z } from "zod/v4";
import { memoryStatusSchema, memoryTypeSchema } from "../../memory/memory-service.js";
import { userMemoryScopeSchema, userMemorySourceKindSchema } from "../../memory/user-memory-service.js";
import { PROJECT_SCHEMA_VERSION } from "../schema.js";
import { ProjectContextError } from "../../shared/errors.js";

export const PACK_MAGIC = Buffer.from("PCMPACK1\n", "ascii");
export const PACK_LIMITS = { manifest: 1024 * 1024, shard: 16 * 1024 * 1024, row: 8 * 1024 * 1024,
  total: 1024 * 1024 * 1024, shards: 16384 } as const;
export const TABLES = ["memories", "memory_sources", "memory_candidates", "tasks",
  "task_events", "task_checkpoint_requests", "user_memories"] as const;
export type PackTable = typeof TABLES[number];
const text = z.string().max(PACK_LIMITS.row);
const id = z.string().min(1).max(256);
const timestamp = z.iso.datetime({ offset: true });
const nullableText = text.nullable();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const json = <T extends z.ZodType>(schema: T) => text.refine(value => {
  try { return schema.safeParse(JSON.parse(value)).success; } catch { return false; }
}, "Invalid structured JSON");
const checkpoint = z.object({
  summary: text.optional(), completed: z.array(text), next: z.array(text), changedFiles: z.array(text),
  verification: z.array(z.object({ command: text, status: text, summary: text.optional() }).strict()),
  blockers: z.array(text), risks: z.array(text),
}).strict();
const taskStatus = z.enum(["in_progress", "completed", "cancelled"]);
const taskSnapshot = z.object({ id, goal: text, status: taskStatus, checkpoint, createdAt: timestamp,
  updatedAt: timestamp, completedAt: timestamp.nullable() }).strict();
const memoryFields = { id, type: memoryTypeSchema, title: text, content: text, reason: nullableText,
  confidence: z.number().min(0).max(1), source_kind: text, created_at: timestamp, updated_at: timestamp };
export const rowSchemas = {
  memories: z.object({ ...memoryFields, status: memoryStatusSchema, scope_json: json(z.array(text)),
    source_ref: nullableText, supersedes_id: id.nullable() }).strict(),
  memory_sources: z.object({ id, memory_id: id, source_kind: text, source_ref: nullableText,
    source_id: z.null(), source_hash: nullableText, start_line: z.number().int().positive().nullable(),
    end_line: z.number().int().positive().nullable(), git_commit: nullableText, created_at: timestamp,
    source_excerpt: nullableText, source_excerpt_hash: nullableText }).strict(),
  memory_candidates: z.object({ ...memoryFields, scope_json: json(z.array(text)), source_ref: nullableText,
    evidence_json: json(z.record(z.string(), z.unknown())), fingerprint: text,
    status: z.enum(["pending", "accepted", "rejected", "superseded"]) }).strict(),
  tasks: z.object({ id, goal: text, status: taskStatus, checkpoint_json: json(checkpoint),
    created_at: timestamp, updated_at: timestamp, completed_at: timestamp.nullable() }).strict(),
  task_events: z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), task_id: id,
    kind: z.enum(["created", "checkpoint", "completed", "cancelled", "migration_snapshot"]),
    recorded_at: timestamp, source: text, snapshot_json: json(taskSnapshot) }).strict(),
  task_checkpoint_requests: z.object({ task_id: id, request_id: id, payload_hash: hash }).strict(),
  user_memories: z.object({ ...memoryFields, status: memoryStatusSchema, scope_level: userMemoryScopeSchema,
    project_id: id.nullable(), scope_ref: nullableText, source_kind: userMemorySourceKindSchema,
    supersedes_id: id.nullable() }).strict(),
} satisfies Record<PackTable, z.ZodType>;

export const manifestSchema = z.object({
  format: z.literal("project-context-knowledge-pack"), version: z.literal(1), kind: z.literal("snapshot"),
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION), createdAt: timestamp,
  sourceProject: z.object({ id, name: text }).strict(),
  policy: z.object({ codeIndex: z.literal(false), sourceExcerpts: z.boolean(),
    userRules: z.literal("explicit-selection"), registrySnapshotAt: timestamp.nullable() }).strict(),
  shards: z.array(z.object({ table: z.enum(TABLES), rows: z.number().int().positive(),
    bytes: z.number().int().positive().max(PACK_LIMITS.shard), sha256: hash }).strict()).max(PACK_LIMITS.shards),
}).strict();
export type PackManifest = z.infer<typeof manifestSchema>;
export type PackRow = Record<string, string | number | null>;
export function invalidPack(message: string): never {
  throw new ProjectContextError("INVALID_REMOTE_PACK", message);
}

export function parseRow(table: PackTable, input: unknown): PackRow {
  const parsed = rowSchemas[table].safeParse(input);
  if (!parsed.success) invalidPack(`Invalid ${table} record.`);
  const row = parsed.data as PackRow;
  if (table === "task_events" && JSON.parse(String(row.snapshot_json)).id !== row.task_id) {
    invalidPack("Task history snapshot does not match its task.");
  }
  if (table === "memory_sources" && row.start_line !== null && row.end_line !== null
    && Number(row.start_line) > Number(row.end_line)) invalidPack("Invalid source line range.");
  if (table === "user_memories") {
    if (row.scope_level === "user" && (row.project_id !== null || row.scope_ref !== null)) invalidPack("Global rule has a project or scope reference.");
    if (row.scope_level === "workspace" && row.project_id !== null) invalidPack("Workspace rule cannot have a project identity.");
    if (row.scope_level === "project" && row.scope_ref !== null) invalidPack("Project rule cannot have an extra scope reference.");
    if (["project", "module", "task"].includes(String(row.scope_level)) && !row.project_id) invalidPack("Rule project scope is missing.");
    if (["workspace", "module", "task"].includes(String(row.scope_level)) && !row.scope_ref) invalidPack("Rule scope reference is missing.");
  }
  return row;
}
