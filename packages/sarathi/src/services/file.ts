/**
 * The project's services file: everything project-specific about a
 * worktree's local services, so the runner and the reaper carry none of it.
 * `.claude/sarathi.json` names it as `worktree.services`: a path from the
 * project root, or a package path (`@scope/package/file.json`) found under
 * `$SARATHI_PACKAGES` when that is set, else under `<root>/node_modules/`.
 *
 * Every key is checked and an unknown one refused, so a typo fails at load
 * rather than as a service that never got its variable.
 *
 * Placeholders, in `environment` values and in commands:
 * - `{password}`: the worktree's service password (URL-encoded in
 *   `environment`, as it goes into URLs there; as it is in commands);
 * - `{serverPort}`, `{webPort}`: this worktree's server port, the web port;
 * - `{project}`: the Compose project name, `<project>-<16 hex>`;
 * - `{<published name>}`: the host port Docker published for that entry,
 *   in `environment` only (a command reads it from there);
 * - `{container:<service>}`: the service's container, `<project name>-<service>-1`.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface Published {
  readonly service: string;
  readonly port: number;
}

export interface Action {
  /** Refused in a linked worktree: it acts on data only the main checkout keeps. */
  readonly mainCheckoutOnly: boolean;
  readonly run: readonly (readonly string[])[];
}

export interface Web {
  readonly command: readonly string[];
  /** The `environment` keys the web command gets; it starts no containers. */
  readonly environment: readonly string[];
}

export interface Server {
  /** Run in order before the server; the first to fail stops the start. */
  readonly before: readonly (readonly string[])[];
  readonly command: readonly string[];
}

export interface ServicesFile {
  readonly path: string;
  /** The Compose file, from the worktree root. */
  readonly compose: string;
  /** The Compose project prefix: each worktree's project is `<project>-<16 hex>`. */
  readonly project: string;
  /** The label naming the worktree root on the resources that outlive containers. */
  readonly rootLabel: string;
  /** The band the server port is drawn from, both ends included. */
  readonly apiPorts: readonly [number, number];
  readonly webPort: number;
  readonly published: Readonly<Record<string, Published>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly web?: Web;
  readonly server?: Server;
  readonly actions: Readonly<Record<string, Action>>;
}

export class ServicesError extends Error {
  override readonly name = 'ServicesError';
}

/** The actions sarathi runs itself; a configured action may not take these names. */
export const BUILT_IN_ACTIONS = ['up', 'down', 'status', 'run', 'web', 'server', 'reap', 'prune'] as const;
const BUILT_IN_PLACEHOLDERS = new Set(['password', 'serverPort', 'webPort', 'project']);
const KEYS = new Set(['compose', 'project', 'rootLabel', 'apiPorts', 'webPort', 'published', 'environment', 'web', 'server', 'actions']);
const PROJECT = /^[a-z][a-z0-9-]{0,39}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ACTION = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// Number.isInteger is false for every non-number.
const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;

function only(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length > 0) throw new ServicesError(`${where}: unknown key ${extra.map(key => `"${key}"`).join(', ')}`);
}

/** The placeholders a template names, in order. */
export function placeholders(template: string): string[] {
  // The one group takes part in every match.
  return [...template.matchAll(PLACEHOLDER)].map(match => match[1] as string);
}

function checkTemplate(template: string, published: ReadonlySet<string>, where: string): void {
  for (const name of placeholders(template)) {
    if (BUILT_IN_PLACEHOLDERS.has(name) || published.has(name)) continue;
    if (name.startsWith('container:') && SERVICE.test(name.slice('container:'.length))) continue;
    throw new ServicesError(`${where}: unknown placeholder {${name}}`);
  }
}

function command(value: unknown, published: ReadonlySet<string>, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(part => typeof part === 'string') || value[0] === '') {
    throw new ServicesError(`${where} must be a command: a non-empty array of strings`);
  }
  const parts = value as string[];
  parts.forEach((part, index) => checkTemplate(part, published, `${where}[${index}]`));
  return parts;
}

function commands(value: unknown, published: ReadonlySet<string>, where: string): string[][] {
  if (!Array.isArray(value)) throw new ServicesError(`${where} must be an array of commands`);
  return value.map((item, index) => command(item, published, `${where}[${index}]`));
}

/** A lookup table with no prototype, so a name such as "constructor" or "toString" is never found unless the file defines it. */
function table<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A relative path that stays inside the folder it is resolved from. */
function inside(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]/).includes('..');
}

function parsePublished(value: unknown, where: string): Record<string, Published> {
  if (!isRecord(value)) throw new ServicesError(`${where} "published" must be an object`);
  const published = table<Published>();
  for (const [name, entry] of Object.entries(value)) {
    if (!NAME.test(name) || BUILT_IN_PLACEHOLDERS.has(name)) {
      throw new ServicesError(`${where} "published": "${name}" must be letters, digits and _, and not ${[...BUILT_IN_PLACEHOLDERS].join(', ')}`);
    }
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !SERVICE.test(entry[0]) || !isPort(entry[1])) {
      throw new ServicesError(`${where} "published.${name}" must be [service, container port]`);
    }
    published[name] = { service: entry[0], port: entry[1] };
  }
  return published;
}

function parseEnvironment(value: unknown, published: ReadonlySet<string>, where: string): Record<string, string> {
  const environment = table<string>();
  if (value === undefined) return environment;
  if (!isRecord(value)) throw new ServicesError(`${where} "environment" must be an object`);
  for (const [name, template] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof template !== 'string') {
      throw new ServicesError(`${where} "environment.${name}" must be a variable name with a string value`);
    }
    checkTemplate(template, published, `${where} "environment.${name}"`);
    environment[name] = template;
  }
  return environment;
}

function parseWeb(value: unknown, environment: Readonly<Record<string, string>>, published: ReadonlySet<string>, where: string): Web | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ServicesError(`${where} "web" must be an object`);
  only(value, ['command', 'environment'], `${where} web`);
  // The web command starts no containers, so nothing it gets may need a published port.
  const run = command(value.command, new Set(), `${where} "web.command"`);
  const names = value.environment ?? [];
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) {
    throw new ServicesError(`${where} "web.environment" must be an array of environment keys`);
  }
  for (const name of names as string[]) {
    const template = environment[name];
    if (template === undefined) throw new ServicesError(`${where} "web.environment": "${name}" is not in "environment"`);
    const needs = placeholders(template).filter(item => published.has(item));
    if (needs.length > 0) throw new ServicesError(`${where} "web.environment": "${name}" needs the published port ${needs.join(', ')}, and web starts no containers`);
  }
  return { command: run, environment: names as string[] };
}

function parseServer(value: unknown, published: ReadonlySet<string>, where: string): Server | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ServicesError(`${where} "server" must be an object`);
  only(value, ['before', 'command'], `${where} server`);
  return {
    before: value.before === undefined ? [] : commands(value.before, published, `${where} "server.before"`),
    command: command(value.command, published, `${where} "server.command"`),
  };
}

function parseActions(value: unknown, published: ReadonlySet<string>, where: string): Record<string, Action> {
  const actions = table<Action>();
  if (value === undefined) return actions;
  if (!isRecord(value)) throw new ServicesError(`${where} "actions" must be an object`);
  for (const [name, spec] of Object.entries(value)) {
    if (!ACTION.test(name) || (BUILT_IN_ACTIONS as readonly string[]).includes(name)) {
      throw new ServicesError(`${where} "actions": "${name}" must be lowercase letters, digits and dashes, and not ${BUILT_IN_ACTIONS.join(', ')}`);
    }
    if (Array.isArray(spec)) {
      actions[name] = { mainCheckoutOnly: false, run: commands(spec, published, `${where} "actions.${name}"`) };
      continue;
    }
    if (!isRecord(spec)) throw new ServicesError(`${where} "actions.${name}" must be an array of commands or { "run": [...] }`);
    only(spec, ['mainCheckoutOnly', 'run'], `${where} actions.${name}`);
    if (spec.mainCheckoutOnly !== undefined && typeof spec.mainCheckoutOnly !== 'boolean') {
      throw new ServicesError(`${where} "actions.${name}.mainCheckoutOnly" must be true or false`);
    }
    actions[name] = { mainCheckoutOnly: spec.mainCheckoutOnly === true, run: commands(spec.run, published, `${where} "actions.${name}.run"`) };
  }
  return actions;
}

/** Checks the services file read from `path`; ServicesError names the first problem. */
export function parseServicesFile(raw: unknown, path: string): ServicesFile {
  if (!isRecord(raw)) throw new ServicesError(`${path} must hold a JSON object`);
  only(raw, [...KEYS], path);
  const { compose, project, rootLabel, apiPorts, webPort } = raw;
  if (typeof compose !== 'string' || compose === '' || !inside(compose)) throw new ServicesError(`${path} "compose" must be a path from the worktree root`);
  if (typeof project !== 'string' || !PROJECT.test(project)) {
    throw new ServicesError(`${path} "project" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (typeof rootLabel !== 'string' || !LABEL.test(rootLabel)) throw new ServicesError(`${path} "rootLabel" must be a Docker label key`);
  if (!Array.isArray(apiPorts) || apiPorts.length !== 2 || !isPort(apiPorts[0]) || !isPort(apiPorts[1]) || apiPorts[0] > apiPorts[1]) {
    throw new ServicesError(`${path} "apiPorts" must be [first, last], two ports in order`);
  }
  if (!isPort(webPort)) throw new ServicesError(`${path} "webPort" must be a port`);
  if (webPort >= apiPorts[0] && webPort <= apiPorts[1]) throw new ServicesError(`${path} "webPort" must lie outside "apiPorts"`);
  const published = parsePublished(raw.published ?? {}, path);
  const names = new Set(Object.keys(published));
  const environment = parseEnvironment(raw.environment, names, path);
  const web = parseWeb(raw.web, environment, names, path);
  // Commands get the published ports through `environment` only: a nested
  // call that reuses its parent's environment has no ports to fill them with.
  const server = parseServer(raw.server, new Set(), path);
  return {
    path,
    compose,
    project,
    rootLabel,
    apiPorts: [apiPorts[0], apiPorts[1]],
    webPort,
    published,
    environment,
    ...(web === undefined ? {} : { web }),
    ...(server === undefined ? {} : { server }),
    actions: parseActions(raw.actions, new Set(), path),
  };
}

export function loadServicesFile(path: string): ServicesFile {
  let text: string;
  try {
    // A Buffer's text is utf8.
    text = String(readFileSync(path));
  } catch {
    throw new ServicesError(`cannot read the services file ${path}; install the project's dependencies, or set SARATHI_PACKAGES for a package path`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ServicesError(`${path} is not JSON`);
  }
  return parseServicesFile(raw, path);
}

/** Where `worktree.services` points: a package path under the packages folder, else a path from `root`. */
export function servicesPath(value: string, root: string, env: Readonly<Record<string, string | undefined>>): string {
  if (!value.startsWith('@')) return isAbsolute(value) ? value : resolve(root, value);
  const packages = env.SARATHI_PACKAGES;
  return join(packages === undefined || packages === '' ? join(root, 'node_modules') : packages, value);
}

export interface Values {
  readonly password: string;
  readonly serverPort: number;
  readonly webPort: number;
  /** The Compose project name, `<prefix>-<16 hex>`. */
  readonly project: string;
  /** Host ports by published name; absent before the containers run. */
  readonly published: Readonly<Record<string, number>>;
}

/** `template` with its placeholders filled; `encode` URL-encodes the password. */
export function expand(template: string, values: Values, encode: boolean): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === 'password') return encode ? encodeURIComponent(values.password) : values.password;
    if (name === 'serverPort') return String(values.serverPort);
    if (name === 'webPort') return String(values.webPort);
    if (name === 'project') return values.project;
    if (name.startsWith('container:')) return `${values.project}-${name.slice('container:'.length)}-1`;
    const port = values.published[name];
    if (port === undefined) throw new ServicesError(`${whole} has no value before the services run`);
    return String(port);
  });
}
