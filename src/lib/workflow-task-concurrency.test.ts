import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartWorkflowTask,
  reservedSkillReviewSlots,
  workflowTaskSlots,
  type RunningWorkflowTaskCapacity,
  type WorkflowTaskCapacity,
} from "@/lib/workflow-task-concurrency";

function task(
  overrides: Partial<WorkflowTaskCapacity> = {},
): WorkflowTaskCapacity {
  return {
    kind: "skill_eval",
    repositoryId: 1,
    totalItems: 1,
    payloadJson: JSON.stringify({ concurrency: 1 }),
    ...overrides,
  };
}

test("counts the capacity requested by a workflow task", () => {
  assert.equal(workflowTaskSlots(task()), 1);
  assert.equal(
    workflowTaskSlots(task({ totalItems: 6, payloadJson: '{"concurrency":7}' })),
    6,
  );
  assert.equal(
    workflowTaskSlots(task({ totalItems: 8, payloadJson: '{"concurrency":3}' })),
    3,
  );
});

test("admits independent one-PR reruns up to repository concurrency", () => {
  const running: RunningWorkflowTaskCapacity[] = Array.from(
    { length: 6 },
    () => ({ kind: "skill_eval", repositoryId: 1, slots: 1 }),
  );
  assert.equal(canStartWorkflowTask(task(), running, 7), true);
  running.push({ kind: "skill_eval", repositoryId: 1, slots: 1 });
  assert.equal(canStartWorkflowTask(task(), running, 7), false);
});

test("does not overlap reruns with a multi-PR skill evaluation", () => {
  const fullRun: RunningWorkflowTaskCapacity[] = [
    { kind: "skill_eval", repositoryId: 1, slots: 7 },
  ];
  assert.equal(canStartWorkflowTask(task(), fullRun, 7), false);
  assert.equal(
    canStartWorkflowTask(
      task({ totalItems: 7, payloadJson: '{"concurrency":7}' }),
      [{ kind: "skill_eval", repositoryId: 1, slots: 1 }],
      7,
    ),
    false,
  );
});

test("reserves only remaining personal skill review capacity", () => {
  assert.equal(
    reservedSkillReviewSlots(
      [
        {
          totalItems: 5,
          currentItem: 4,
          payloadJson: '{"concurrency":5}',
        },
      ],
      5,
    ),
    1,
  );
});

test("caps combined personal skill reservations at repository concurrency", () => {
  assert.equal(
    reservedSkillReviewSlots(
      [
        {
          totalItems: 5,
          currentItem: 0,
          payloadJson: '{"concurrency":5}',
        },
        {
          totalItems: 1,
          currentItem: 0,
          payloadJson: '{"concurrency":1}',
        },
      ],
      5,
    ),
    5,
  );
});

test("reserves full capacity while a task parallelizes review snapshots", () => {
  assert.equal(
    reservedSkillReviewSlots(
      [
        {
          totalItems: 3,
          currentItem: 2,
          payloadJson:
            '{"concurrency":5,"snapshotParallelism":true}',
        },
      ],
      5,
    ),
    5,
  );
});
