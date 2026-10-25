import { AiError } from "./errors";
import type { AiJobDefinition } from "./types";

const jobs = new Map<string, AiJobDefinition<unknown, unknown>>();

function registryKey(key: string, version: string) {
  return `${key}@${version}`;
}

export function registerAiJob<TInput, TOutput>(job: AiJobDefinition<TInput, TOutput>): void {
  const key = registryKey(job.key, job.version);
  if (jobs.has(key)) throw new AiError(`AI job is already registered: ${key}`);
  jobs.set(key, job as AiJobDefinition<unknown, unknown>);
}

export function getAiJob(key: string, version?: string): AiJobDefinition<unknown, unknown> {
  const candidates = Array.from(jobs.entries()).filter(([entry]) => entry.startsWith(`${key}@`));
  const selected = version ? jobs.get(registryKey(key, version)) : candidates.at(-1)?.[1];
  if (!selected) throw new AiError(`Unknown AI job: ${version ? registryKey(key, version) : key}`);
  return selected;
}
