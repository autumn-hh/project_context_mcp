import type { TaskCheckpoint } from '../../src/tasks/task-service.js';
// Explicit acceptance evidence for fixtures whose subject is history/transport,
// not acceptance validation (covered independently in task-workflow.test.ts).
export const fixtureAcceptance = (): Pick<TaskCheckpoint, 'acceptance'> => ({
  acceptance: [{ criterion: 'Fixture scope validated', status: 'passed', evidence: 'test:fixture-validation' }],
});
export const completedFixture = (): TaskCheckpoint => ({
  summary:'Fixture scope complete', completed:[], next:[], changedFiles:[], verification:[], blockers:[], risks:[], ...fixtureAcceptance(),
});
