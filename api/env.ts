export type Env = Record<string, string | undefined>;

// Avoid referencing the `process` identifier directly so TypeScript doesn't require Node typings
// in repos where `api/*` isn't included in the main tsconfig.
export const env: Env = ((globalThis as any)?.process?.env ?? {}) as Env;
