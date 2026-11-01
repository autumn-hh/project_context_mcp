import { z } from "zod/v4";
import { MEMORY_GRAPH_RELATIONS } from "./graph-service.js";

export const memoryGraphNodeIdSchema = z.string().min(1).max(8_192)
  .refine((value) => !/[\u0000-\u001f]/u.test(value), "Invalid graph node ID.");

export const memoryGraphInputShape = {
  view: z.enum(["knowledge", "evidence", "entities"]).default("knowledge"),
  includeSummaries: z.boolean().default(false),
  query: z.string().trim().max(200).optional(),
  nodeId: memoryGraphNodeIdSchema.optional(),
  depth: z.number().int().min(1).max(2).default(1),
  limit: z.number().int().min(1).max(150).default(24),
  includeInactive: z.boolean().default(false),
  relationTypes: z.array(z.enum(MEMORY_GRAPH_RELATIONS)).max(MEMORY_GRAPH_RELATIONS.length).optional(),
};

export const memoryGraphInputSchema = z.object(memoryGraphInputShape).strict();
