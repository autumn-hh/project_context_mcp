import { z } from "zod/v4";

export const KNOWLEDGE_ENTITY_TYPES = ["project", "service", "module", "storage", "rule", "technology", "concept"] as const;
export const KNOWLEDGE_RELATION_TYPES = ["uses", "provides", "stored_in", "depends_on", "governed_by"] as const;
export const KNOWLEDGE_STATUSES = ["pending", "accepted", "rejected", "superseded"] as const;
export const MAX_KNOWLEDGE_DOCUMENT_LENGTH = 65_536;

const labelSchema = z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Names cannot contain control characters.");
const keySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const evidenceSchema = z.string().min(1).max(1000).refine((value) => !value.includes("\0"), "Evidence cannot contain NUL.");

export const knowledgeDocumentSchema = z.object({
  entities: z.array(z.object({
    key: keySchema,
    name: labelSchema,
    type: z.enum(KNOWLEDGE_ENTITY_TYPES),
    aliases: z.array(labelSchema).max(8).default([]),
    evidence: evidenceSchema,
  }).strict()).min(1).max(12),
  relations: z.array(z.object({
    from: keySchema,
    to: keySchema,
    type: z.enum(KNOWLEDGE_RELATION_TYPES),
    evidence: evidenceSchema,
  }).strict()).max(24),
}).strict().superRefine((document, context) => {
  if (JSON.stringify(document).length > MAX_KNOWLEDGE_DOCUMENT_LENGTH) {
    context.addIssue({ code: "custom", message: "Knowledge document exceeds the total length limit." });
  }
  const keys = new Set<string>();
  for (const [index, entity] of document.entities.entries()) {
    if (keys.has(entity.key)) context.addIssue({ code: "custom", path: ["entities", index, "key"], message: "Entity keys must be unique." });
    keys.add(entity.key);
  }
  const relations = new Set<string>();
  for (const [index, relation] of document.relations.entries()) {
    if (!keys.has(relation.from) || !keys.has(relation.to)) {
      context.addIssue({ code: "custom", path: ["relations", index], message: "Both relationship endpoints must name declared entities." });
    }
    if (relation.from === relation.to) context.addIssue({ code: "custom", path: ["relations", index], message: "Self relationships are not allowed." });
    const key = JSON.stringify([relation.from, relation.to, relation.type, relation.evidence]);
    if (relations.has(key)) context.addIssue({ code: "custom", path: ["relations", index], message: "Duplicate relationship." });
    relations.add(key);
  }
});

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeEntity = KnowledgeDocument["entities"][number];
export type KnowledgeRelation = KnowledgeDocument["relations"][number];
export type KnowledgeStatus = typeof KNOWLEDGE_STATUSES[number];

export const knowledgeRowSchema = z.object({
  id: z.string().regex(/^mknow_[a-f0-9]{64}$/u),
  memory_id: z.string().min(1).max(200),
  memory_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  document_json: z.string().min(1).max(MAX_KNOWLEDGE_DOCUMENT_LENGTH).superRefine((value, context) => {
    try {
      if (!knowledgeDocumentSchema.safeParse(JSON.parse(value)).success) {
        context.addIssue({ code: "custom", message: "document_json must contain a valid knowledge document." });
      }
    } catch {
      context.addIssue({ code: "custom", message: "document_json must be valid JSON." });
    }
  }),
  status: z.enum(KNOWLEDGE_STATUSES),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type KnowledgeRow = z.infer<typeof knowledgeRowSchema>;
