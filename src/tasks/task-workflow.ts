import { z } from 'zod/v4';

export const taskStageSchema = z.enum(['untriaged', 'backlog', 'executing', 'acceptance', 'waiting', 'paused']);
export const taskAcceptanceSchema = z.array(z.object({
  criterion: z.string().trim().min(1).max(2000),
  status: z.enum(['pending', 'passed']),
  evidence: z.string().trim().max(4000).optional(),
}).strict()).max(100);
export const taskWorkflowShape = {
  stage: taskStageSchema.optional().describe('Work stage, separate from lifecycle status. New tasks default to executing; backlog is unscheduled, untriaged needs review. Pause only on explicit user instruction.'),
  acceptance: taskAcceptanceSchema.optional().describe('Completion criteria and evidence. Replaces the entire list when supplied; every criterion needs passed status and non-empty evidence before completion.'),
  waitingReason: z.string().trim().max(2000).optional().describe('Required for waiting or paused stages. Describe the external condition or explicit user pause decision.'),
};
export const taskWorkflowSchema = z.object(taskWorkflowShape).strict();
export type TaskWorkflow = z.infer<typeof taskWorkflowSchema>;
