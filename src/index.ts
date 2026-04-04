export { SynthLoop } from "./loop.js";
export type { LogFn } from "./loop.js";
export { scanDiff, generateHardenedGitignore } from "./security.js";
export {
  buildDiscoverPrompt, buildAnalyzePrompt, buildImplementPrompt, buildFixPrompt,
  getDefaultRepos,
} from "./discover.js";
export {
  morphFastApply, context7Search, context7Docs,
  hasMorphKey, hasContext7Key,
} from "./morph.js";
export type {
  LoopConfig, LoopState, CycleResult, Pattern, Gap,
  VerifyResult, SecurityResult, SecurityIssue, RepoSource,
} from "./types.js";
