/// <reference lib="webworker" />
// Runs as an inlined worker (?worker&inline) so the single-file production
// build still gets a real multicore simulation pool.
import {
  evaluateTrainingTrial, runSlice, runTraining,
  type GamePlanItem, type LearningState, type RunSettings, type SliceResult, type TrainingResult, type TrainingTrial,
} from './batch';
import { applyRuleset, type RulesetSnapshot } from './config';

type Task =
  | { type: 'train'; id: number; settings: RunSettings; learning: LearningState; rules: RulesetSnapshot }
  | { type: 'slice'; id: number; settings: RunSettings; learning: LearningState; rules: RulesetSnapshot; plan: GamePlanItem[]; from: number; to: number }
  | { type: 'trial'; id: number; trial: TrainingTrial; rules: RulesetSnapshot }
  | { type: 'cancel' };

type Message =
  | { type: 'progress'; id: number; payload: unknown }
  | { type: 'done'; id: number; result: TrainingResult | SliceResult | number | null }
  | { type: 'error'; id: number; message: string };

const context = self as unknown as DedicatedWorkerGlobalScope;
let cancelled = false;

context.onmessage = (event: MessageEvent<Task>) => {
  const task = event.data;
  if (task.type === 'cancel') {
    cancelled = true;
    return;
  }
  cancelled = false;
  const post = (message: Message) => context.postMessage(message);
  const work = async () => {
    applyRuleset(task.rules);
    if (task.type === 'trial') {
      const result = evaluateTrainingTrial(task.trial);
      post({ type: 'done', id: task.id, result: cancelled ? null : result });
    } else if (task.type === 'train') {
      const result = await runTraining(task.settings, task.learning,
        (progress) => post({ type: 'progress', id: task.id, payload: progress }), () => cancelled);
      post({ type: 'done', id: task.id, result });
    } else {
      const result = await runSlice(task.settings, task.learning, task.plan, task.from, task.to,
        (progress) => post({ type: 'progress', id: task.id, payload: progress }), () => cancelled);
      post({ type: 'done', id: task.id, result });
    }
  };
  void work().catch((error: unknown) => post({ type: 'error', id: task.id,
    message: error instanceof Error ? error.message : String(error) }));
};
