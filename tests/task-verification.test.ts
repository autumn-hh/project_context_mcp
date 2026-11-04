import { it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { summarizeVerification } from '../src/tasks/task-verification.js';

it('keeps latest commands distinct and never marks negative status text as passed, including browser serialization',()=>{
  const items=[{command:'test',status:'failed'},{command:'test ',status:'PASSED'},
    {command:'lint',status:'not passed'},{command:'build',status:'incomplete'},
    {command:'launch',status:'not ok'},{command:'check',status:'unsuccessful'},{command:'',status:'passed'}];
  const result=summarizeVerification(items);
  expect(result.current).toHaveLength(6);expect(result.unresolved).toBe(5);
  expect(result.superseded).toEqual([items[0]]);
  const browser=runInNewContext('('+summarizeVerification.toString()+')');
  expect(JSON.parse(JSON.stringify(browser(items)))).toEqual(result);
});
