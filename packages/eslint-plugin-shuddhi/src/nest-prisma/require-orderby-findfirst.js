/**
 * BP-DB-004: Prisma findFirst must include orderBy
 *
 * findFirst() without orderBy returns a non-deterministic result because
 * the database does not guarantee row ordering. This rule requires an
 * orderBy property in the options object passed to findFirst().
 *
 * ✅ prisma.user.findFirst({ where: { id }, orderBy: { createdAt: 'desc' } })
 * ❌ prisma.user.findFirst({ where: { id } })
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require orderBy in Prisma findFirst() calls for deterministic results',
    },
    messages: {
      missingOrderBy:
        'Prisma findFirst() without orderBy returns non-deterministic results. Add an orderBy clause.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;

        // Match: <expr>.findFirst(...)
        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'findFirst'
        ) {
          return;
        }

        const args = node.arguments;

        // findFirst() with no arguments — always non-deterministic
        if (args.length === 0) {
          context.report({ node, messageId: 'missingOrderBy' });
          return;
        }

        const optionsArg = args[0];

        // If the options argument is not an object literal (e.g., a variable),
        // we can't statically verify — skip to avoid false positives
        if (optionsArg.type !== 'ObjectExpression') {
          return;
        }

        // Check if the object has an 'orderBy' property
        const hasOrderBy = optionsArg.properties.some(
          prop =>
            prop.type === 'Property' &&
            ((prop.key.type === 'Identifier' && prop.key.name === 'orderBy') ||
              (prop.key.type === 'Literal' && prop.key.value === 'orderBy')),
        );

        if (!hasOrderBy) {
          context.report({ node, messageId: 'missingOrderBy' });
        }
      },
    };
  },
};
