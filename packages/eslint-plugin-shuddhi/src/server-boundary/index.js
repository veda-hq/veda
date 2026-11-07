/**
 * Server-boundary lint rules.
 *
 * Four catalogue checks, each a defect class reviewers kept reporting at the
 * API boundary:
 *
 *   VAL-01      nest-body-dto           @Body must be a validated DTO class
 *   VAL-03      dto-field-constraints   DTO / zod fields carry the constraint
 *                                       their name implies
 *   CONTRACT-03 no-local-api-contract   request/response shapes come from
 *                                       the shared contracts package, not a
 *                                       local redeclaration
 *               dto-implements-contract server DTOs implement that shared type
 *               no-capability-literal   a client names capabilities through
 *                                       the shared vocabulary, never as strings
 *   RACE-02     compare-and-set         a guarded write names its guard in WHERE
 *
 * One module per rule beside this entry, each with its colocated suite; this
 * entry registers them in one rule map, and ./configs.js mounts that map
 * under a plugin namespace with the config blocks a workspace imports.
 *
 * Every rule is a heuristic over the AST (plus the type checker where one is
 * configured). Each states what it deliberately does NOT claim, because a
 * codebase that bans `eslint-disable` gives a rule that fires on correct code
 * no escape hatch except a suppression count.
 */

import nestBodyDto from './nest-body-dto.js';
import dtoFieldConstraints from './dto-field-constraints.js';
import noLocalApiContract from './no-local-api-contract.js';
import dtoImplementsContract from './dto-implements-contract.js';
import noCapabilityLiteral from './no-capability-literal.js';
import compareAndSet from './compare-and-set.js';

export { decoratorName } from './helpers.js';
export { zodChain } from './dto-field-constraints.js';
export { readCapabilityVocabulary } from './no-capability-literal.js';
export { regressingCursorColumns } from './compare-and-set.js';

export const rules = {
  'nest-body-dto': nestBodyDto,
  'dto-field-constraints': dtoFieldConstraints,
  'no-local-api-contract': noLocalApiContract,
  'dto-implements-contract': dtoImplementsContract,
  'no-capability-literal': noCapabilityLiteral,
  'compare-and-set': compareAndSet,
};
