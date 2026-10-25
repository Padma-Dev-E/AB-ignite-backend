import { AiError } from "./errors";
const jobs = new Map();
function registryKey(key, version) {
    return `${key}@${version}`;
}
export function registerAiJob(job) {
    const key = registryKey(job.key, job.version);
    if (jobs.has(key))
        throw new AiError(`AI job is already registered: ${key}`);
    jobs.set(key, job);
}
export function getAiJob(key, version) {
    const candidates = Array.from(jobs.entries()).filter(([entry]) => entry.startsWith(`${key}@`));
    const selected = version ? jobs.get(registryKey(key, version)) : candidates.at(-1)?.[1];
    if (!selected)
        throw new AiError(`Unknown AI job: ${version ? registryKey(key, version) : key}`);
    return selected;
}
