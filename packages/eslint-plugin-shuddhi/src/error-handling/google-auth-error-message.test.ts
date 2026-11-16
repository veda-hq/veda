import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { rules } from './index.js';

/**
 * The cases for `google-auth-error-message.js`, the module this suite owns.
 *
 * Each `invalid` case is the lesson's shape, reduced: the error a
 * google-auth-library verification throws, whose message embeds the raw ID
 * token or its claims, carried into a log, a response or a new error. Each
 * `valid` case is the corrected code (the message classified by its constant
 * prefix, only a fixed code logged) or a near miss. The `guard removal` block
 * puts the message back where the classifier was and proves the rule fires
 * again.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const FILE = 'src/auth/auth.service.ts';

/** A try around the verification, then `body` as its catch. */
const verifying = (body: string, param = 'error') =>
  `async function verify(idToken: string) {
    try {
      ticket = await this.googleClient.verifyIdToken({ idToken, audience: this.googleClientId });
    } catch (${param}) {
      ${body}
    }
  }`;

const leaks = (text: string, sink: string) => ({
  messageId: 'leaks',
  data: { text, sink },
});

/** athya's real catch: a classifier on the error, a fixed code logged. */
const CLASSIFIED = verifying(`this.logger.warn('Auth failed: Google token rejected', {
        reason: classifyGoogleTokenFailure(error),
        audience: this.googleClientId,
      });
      throw new UnauthorizedException('Google token verification failed');`);

ruleTester.run('google-auth-error-message', rules['google-auth-error-message']!, {
  valid: [
    // Corrected: the classifier reads the error; only its fixed code is logged.
    { filename: FILE, code: CLASSIFIED },
    // Corrected: the classifier inline, by the message's constant prefix.
    {
      filename: FILE,
      code: verifying(`const reason =
        error instanceof Error && error.message.startsWith('Token used too late')
          ? 'GOOGLE_TOKEN_EXPIRED'
          : 'GOOGLE_TOKEN_VERIFY_UNKNOWN';
      this.logger.warn('Auth failed: Google token rejected', { reason });
      throw new UnauthorizedException('Google token verification failed');`),
    },
    // A rethrow or return of the caught value itself adds nothing.
    { filename: FILE, code: verifying(`if (retry) throw error; return error;`) },
    // Fields that carry no token, comparisons, a condition, a computed key,
    // an assignment, a const never used, a tagged template.
    {
      filename: FILE,
      code: verifying(`this.logger.warn('rejected', { code: error.code, name: error.name, [error.message]: 1 });
      if (error.message === 'x') count += 1;
      this.logger.warn(error ? 'failed' : 'passed');
      lastError = error.message;
      const unused = error.message;
      this.logger.warn(redact\`\${error.message}\`);
      this.logger.warn(error.message.length > 0 ? 'long' : 'short');
      error.message;`),
    },
    // A const chain is followed three deep, no further.
    {
      filename: FILE,
      code: verifying(`const a = error.message; const b = a; const c = b; const d = c;
      this.logger.warn(d);`),
    },
    // A try that verifies nothing; a catch with no binding.
    {
      filename: FILE,
      code: `try { await fetchUser(id); } catch (error) { this.logger.warn(error.message); }
      try { await client.verifyIdToken({ idToken }); } catch { this.logger.warn('rejected'); }`,
    },
    // Not read: a verification reached by a computed name, a destructured
    // catch binding or a destructured message, a computed member, a log
    // method reached by a computed name.
    {
      filename: FILE,
      code: `try { await client['verifyIdToken']({ idToken }); } catch (error) { this.logger.warn(error.message); }
      try { await client.verifyIdToken({ idToken }); } catch ({ message }) { this.logger.warn(message); }
      ${verifying(`const { message } = error;
      this.logger.warn(error['message']);
      this.logger['warn'](error.message);`)}`,
    },
  ],
  invalid: [
    // The lesson: the library's message, carrying the token, logged as a field.
    {
      filename: FILE,
      code: verifying(`this.logger.warn('Auth failed: Google token rejected', { error: error.message });
      throw new UnauthorizedException('Google token verification failed');`),
      errors: [leaks('error.message', 'a `warn` call')],
    },
    // Wrapped into the error the response shows.
    {
      filename: FILE,
      code: verifying(`throw new UnauthorizedException(\`Google token invalid: \${error.message}\`);`),
      errors: [leaks('error.message', 'a new error')],
    },
    // Thrown or returned as text.
    {
      filename: FILE,
      code: verifying(`if (strict) throw String(error);
      return { ok: false, detail: 'rejected: ' + error.stack };`),
      errors: [
        leaks('error', 'a thrown value'),
        leaks('error.stack', 'a returned value'),
      ],
    },
    // Sent as a response, stringified or not.
    {
      filename: FILE,
      code: verifying(`res.status(401).json({ message: error.message });
      reply.send(JSON.stringify(error));`),
      errors: [
        leaks('error.message', 'a `json` response'),
        leaks('error', 'a `send` response'),
      ],
    },
    // Every logging name, through errorDetail, toString, a const, a logical
    // and a conditional, an array, a spread and type wrappers.
    {
      filename: FILE,
      code: verifying(`console.error(error);
      this.logger.debug(errorDetail(error));
      safeLog(this.logger, 'rejected', error.toString());
      const reason = error.message;
      this.logger.error(reason);
      this.logger.info(error.message || 'none');
      this.logger.info(strict ? error.message : 'x');
      this.logger.log(['rejected', error.stack]);
      this.logger.trace(...[error]);
      this.logger.fatal((error as Error).message);
      (this.logger.warn as Log)(error!.message);`),
      errors: [
        leaks('error', 'a `error` call'),
        leaks('error', 'a `debug` call'),
        leaks('error.toString', 'a `safeLog` call'),
        leaks('error.message', 'a `error` call'),
        leaks('error.message', 'a `info` call'),
        leaks('error.message', 'a `info` call'),
        leaks('error.stack', 'a `log` call'),
        leaks('error', 'a `trace` call'),
        leaks('error', 'a `fatal` call'),
        leaks('error', 'a `warn` call'),
      ],
    },
    // The other verification methods, on any object; a const three deep.
    {
      filename: FILE,
      code: `try { client.verifySignedJwtWithCerts(jwt, certs); } catch (e) { safeInvoke(() => 0, e.message); }
      try { await client.verifySignedJwtWithCertsAsync(jwt, certs); } catch (e) { const a = e.message; const b = a; const c = b; log(c); }
      try { const info = await auth.getTokenInfo(token); use(info); } catch (e) { warn(e.stack); }`,
      errors: [
        leaks('e.message', 'a `safeInvoke` call'),
        leaks('e.message', 'a `log` call'),
        leaks('e.stack', 'a `warn` call'),
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(code: string): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { shuddhi: { rules } },
          rules: { 'shuddhi/google-auth-error-message': 'error' },
        },
      ],
      FILE,
    )
    .map(message => message.messageId ?? message.message);
}

describe('guard removal flips each corrected case', () => {
  it('google-auth-error-message/leaks', () => {
    assert.deepEqual(messageIds(CLASSIFIED), []);
    const broken = CLASSIFIED.replace(
      'classifyGoogleTokenFailure(error)',
      'error.message',
    );
    assert.notEqual(broken, CLASSIFIED);
    assert.deepEqual(messageIds(broken), ['leaks']);
  });
});

describe('google-auth-error-message rule metadata', () => {
  it('states the rule and its message verbatim', () => {
    assert.deepEqual(rules['google-auth-error-message']?.meta, {
      type: 'problem',
      docs: {
        description:
          "A google-auth-library verification error's text never reaches a log, a response or a new error",
      },
      schema: [],
      messages: {
        leaks:
          "google-auth-library's verification errors embed the raw ID token or its claims in `message`, so `{{text}}` here puts a bearer credential into {{sink}}. Classify the message by its constant prefix (`message.startsWith(...)`) and log or return only a fixed code.",
      },
    });
  });
});
