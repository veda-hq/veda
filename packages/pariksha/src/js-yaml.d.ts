// js-yaml 4 ships no declarations; this is the part pariksha and its tests call.
declare module 'js-yaml' {
  export interface LoadOptions {
    readonly schema?: unknown;
  }
  export const FAILSAFE_SCHEMA: unknown;
  /** Parses one YAML document; throws a YAMLException when it does not parse. */
  export function load(source: string, options?: LoadOptions): unknown;
}
