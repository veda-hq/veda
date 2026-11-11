import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareIdentifiers, compareVersions, parseRange, parseVersion, satisfies, validRange, validVersion } from './semver-range.ts';

const v = (text: string) => {
  const parsed = parseVersion(text);
  if (parsed === undefined) throw new Error(`${text} is not a version`);
  return parsed;
};

describe('parseVersion and validVersion', () => {
  it('reads full versions, trimmed, with v, prerelease and build', () => {
    assert.deepEqual(parseVersion(' v1.2.3-beta.1+build.5 '), { main: [1, 2, 3], prerelease: ['beta', '1'] });
    assert.deepEqual(parseVersion('0.0.0'), { main: [0, 0, 0], prerelease: [] });
    assert.equal(validVersion('10.20.30-0.a-b.--'), true);
  });

  it('refuses anything else', () => {
    for (const text of ['1.2', '1.2.x', '01.2.3', '1.02.3', '1.2.3-01', '1.2.3-', '1.2.3+', '=1.2.3', '>=1.2.3', 'vv1.2.3', '^1.2.3', '', 'latest', `1.2.3-${'a'.repeat(260)}`, '9007199254740992.0.0']) {
      assert.equal(validVersion(text), false, text);
    }
    assert.equal(validVersion(123), false);
    assert.equal(validVersion(undefined), false);
  });
});

describe('compareIdentifiers and compareVersions', () => {
  it('orders numbers numerically, before words, words in ASCII order', () => {
    assert.equal(compareIdentifiers('2', '10'), -1);
    assert.equal(compareIdentifiers('10', '2'), 1);
    assert.equal(compareIdentifiers('1', 'a'), -1);
    assert.equal(compareIdentifiers('a', '1'), 1);
    assert.equal(compareIdentifiers('B', 'a'), -1);
    assert.equal(compareIdentifiers('b', 'a'), 1);
    assert.equal(compareIdentifiers('x', 'x'), 0);
  });

  it('follows semver precedence, build ignored', () => {
    const order = ['1.0.0-0', '1.0.0-1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
    for (let i = 0; i + 1 < order.length; i++) {
      assert.equal(compareVersions(v(order[i] ?? ''), v(order[i + 1] ?? '')), -1, `${order[i]} < ${order[i + 1]}`);
      assert.equal(compareVersions(v(order[i + 1] ?? ''), v(order[i] ?? '')), 1);
    }
    assert.equal(compareVersions(v('1.0.0+a'), v('1.0.0+b')), 0);
    assert.equal(compareVersions(v('1.0.0-a.1'), v('1.0.0-a.1')), 0);
  });
});

describe('parseRange and validRange', () => {
  it('reads comparator sets, AND by space and OR by ||', () => {
    assert.equal(parseRange('>=1.0.0 <2.0.0 || =3.0.0')?.length, 2);
    for (const range of ['<1.7.1', '>=7.5.21 <8.0.0', '>= 1.2.3', '>v1.2.3', '1.2.3', '=1.2.3', '>=1.2.3+build <2.0.0', '', '||', ' >=1.0.0  ||  <0.5.0 ', '+build']) {
      assert.equal(validRange(range), true, JSON.stringify(range));
    }
  });

  it('reads the sugar semver reads', () => {
    for (const range of ['^1.2.3', '^ 1.2.3', '~1.2.3', '~>1.2', '~ 1.2.3', '1.2', '1.x', '1.2.X', '*', 'x', '>=1.2', '<8', '>=0.8.15 <0.9', '1.2.3 - 2.0.0', '1.2 - 2', '>=1.2.3 <2', '>*']) {
      assert.equal(validRange(range), true, range);
    }
  });

  it('turns the sugar into plain comparators', () => {
    assert.deepEqual(parseRange('*'), [[{ operator: '' }]]);
    assert.deepEqual(parseRange('>=0'), [[{ operator: '' }]]);
    assert.deepEqual(parseRange('<8'), [[{ operator: '<', version: v('8.0.0-0') }]]);
  });

  it('refuses what semver refuses', () => {
    for (const range of ['npm:other@1.0.0', '==1.2.3', 'latest', '>', '1.2.3.4', '01.2.3', `>=1.2.3-${'a'.repeat(260)}`, '>=9007199254740992.0.0']) {
      assert.equal(validRange(range), false, range);
    }
    assert.equal(validRange(7), false);
    assert.equal(validRange(null), false);
  });
});

describe('satisfies, with the sugar', () => {
  const cases: [string, string, boolean][] = [
    // partial and x-range versions; a partial bound starts at `-0`
    ['<8', '7.99.99', true],
    ['<8', '8.0.0-0', false],
    ['>=0.8.15 <0.9', '0.8.20', true],
    ['>=0.8.15 <0.9', '0.9.0-beta', false],
    ['>=1.2', '1.2.0-alpha', true],
    ['1.2', '1.2.0-0', true],
    ['1.2', '1.3.0-0', false],
    ['1.2.x', '1.2.9', true],
    ['=1.x', '1.9.0', true],
    ['=1.x', '2.0.0-0', false],
    ['1', '1.0.0-0', true],
    ['>1.2', '1.3.0-0', true],
    ['>1.2', '1.2.9', false],
    ['>1', '2.0.0-0', true],
    ['>1', '1.9.9', false],
    ['<=1.2', '1.2.99', true],
    ['<=1.2', '1.3.0-0', false],
    ['<=1', '1.9.9', true],
    ['<=1', '2.0.0-0', false],
    ['*', '0.0.0-0', true],
    ['x', '9.9.9', true],
    ['>=*', '1.0.0', true],
    ['>*', '0.0.0', false],
    ['<x', '0.0.0-0', false],
    ['>=0.0.0', '0.0.0-0', false],
    // carets: no `-0` on a full lower bound above 0.x
    ['^1.2.3', '1.9.9', true],
    ['^1.2.3', '1.2.3-beta', false],
    ['^1.2.3', '2.0.0-0', false],
    ['^1', '1.0.0-0', true],
    ['^1.2', '1.2.0-0', true],
    ['^0.2', '0.3.0-0', false],
    ['^0.1.2', '0.1.2-beta', true],
    ['^0.1.2', '0.2.0', false],
    ['^0.0.1', '0.0.2-0', false],
    ['^1.2.3-beta.2', '1.2.3-beta.1', false],
    ['^1.2.3-beta.2', '1.2.3-beta.3', true],
    ['^0.0.1-pr', '0.0.2-0', false],
    ['^0.1.1-pr', '0.1.9', true],
    ['^*', '0.0.0-0', true],
    // tildes: no `-0` on any lower bound
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0-0', false],
    ['~1', '1.0.0-0', false],
    ['~1', '1.9.0', true],
    ['~1.2', '1.2.0', true],
    ['~>1.2.3', '1.2.4', true],
    ['~1.2.3-rc', '1.2.3-rc.1', true],
    ['~*', '0.0.0-0', true],
    // hyphen ranges
    ['1.2.3 - 2.3.4', '2.3.4', true],
    ['1.2.3 - 2.3.4', '2.3.5-0', false],
    ['1.2.3 - 2.3.4', '1.2.3-0', true],
    ['1.2 - 2.3', '2.3.9', true],
    ['1 - 2', '2.9.9', true],
    ['1 - 2', '3.0.0-0', false],
    ['* - 2.0.0', '0.0.0', true],
    ['1.2.3 - *', '9.0.0', true],
    ['1.2.3-rc - 2.3.4-rc', '2.3.4-rc', true],
    ['1.2.3-rc - 2.3.4-rc', '2.3.4', false],
  ];
  for (const [range, version, expected] of cases) {
    it(`${version} ${expected ? 'is' : 'is not'} in ${range}`, () => {
      assert.equal(satisfies(version, range), expected);
    });
  }
});

describe('satisfies', () => {
  it('tests each operator', () => {
    assert.equal(satisfies('1.2.3', '<1.2.4'), true);
    assert.equal(satisfies('1.2.4', '<1.2.4'), false);
    assert.equal(satisfies('1.2.4', '<=1.2.4'), true);
    assert.equal(satisfies('1.2.5', '<=1.2.4'), false);
    assert.equal(satisfies('1.2.5', '>1.2.4'), true);
    assert.equal(satisfies('1.2.4', '>1.2.4'), false);
    assert.equal(satisfies('1.2.4', '>=1.2.4'), true);
    assert.equal(satisfies('1.2.3', '>=1.2.4'), false);
    assert.equal(satisfies('1.2.4', '1.2.4'), true);
    assert.equal(satisfies('1.2.4+b', '=1.2.4'), true);
    assert.equal(satisfies('1.2.5', '=1.2.4'), false);
  });

  it('includes prereleases, by precedence', () => {
    assert.equal(satisfies('7.5.20-beta.1', '<=7.5.20'), true);
    assert.equal(satisfies('4.0.0-beta.3', '>=4.0.0-beta.3 <5.7.0'), true);
    assert.equal(satisfies('4.0.0-beta.2', '>=4.0.0-beta.3 <5.7.0'), false);
    assert.equal(satisfies('5.7.0-rc.1', '>=4.0.0-beta.3 <5.7.0'), true);
    assert.equal(satisfies('2.0.0-0', '>=1.0.0 <2.0.0'), true);
  });

  it('matches any set, every comparator of it; an empty set matches all', () => {
    assert.equal(satisfies('3.0.0', '>=1.0.0 <2.0.0 || 3.0.0'), true);
    assert.equal(satisfies('2.5.0', '>=1.0.0 <2.0.0 || 3.0.0'), false);
    assert.equal(satisfies('9.9.9', ''), true);
  });

  it('is false when either does not parse', () => {
    assert.equal(satisfies('1.2', '>=1.0.0'), false);
    assert.equal(satisfies('1.2.3', 'latest'), false);
  });
});
