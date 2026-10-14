import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAmount, multiplyDecimal, normaliseHost, plainDecimal, plainNumber, queryString, roundDecimal } from '../../dist/esm/support.js';

test('formatAmount', () => {
  assert.equal(formatAmount(10), '10');
  assert.equal(formatAmount(49.9), '49.9');
  assert.equal(formatAmount('49.90'), '49.90');
  assert.equal(formatAmount(0.00001), '0.00001');
  assert.equal(formatAmount(' 12.5 '), '12.5');
  assert.equal(formatAmount(0.1 + 0.2), '0.3');
  assert.equal(formatAmount(100), '100');
  for (const bad of [0, -1, '1,5', 'abc', NaN, Infinity, '', '1e5', null]) {
    assert.throws(() => formatAmount(bad), undefined, String(bad));
  }
});

test('plainNumber', () => {
  assert.equal(plainNumber(1e-7), '0.0000001');
  assert.equal(plainNumber(2.5e-6), '0.0000025');
  assert.equal(plainNumber(1e21), '1000000000000000000000');
  assert.equal(plainNumber(' 3 '), '3');
  assert.equal(plainNumber(undefined), '');
});

test('normaliseHost', () => {
  assert.equal(normaliseHost('HTTPS://api-shop-1.paygate.to/control/', 'x'), 'api-shop-1.paygate.to');
  assert.equal(normaliseHost('pay.myshop.com.', 'x'), 'pay.myshop.com');
  assert.throws(() => normaliseHost('evil.example@paygate.to', 'x'));
  assert.throws(() => normaliseHost('localhost', 'x'));
});

test('queryString encodes like PHP rawurlencode', () => {
  assert.equal(queryString({ a: '1 2', b: '', n: null, u: undefined, c: "x+y!'()*~" }), "?a=1%202&c=x%2By%21%27%28%29%2A~");
  assert.equal(queryString({ t: 'ab%3D' }, ['t']), '?t=ab%3D');
  assert.equal(queryString({ t: 'ab=' }, ['t']), '?t=ab%3D');
  assert.equal(queryString({ t: 'a%2F&x=1' }, ['t']), '?t=a%252F%26x%3D1');
  assert.equal(queryString({}), '');
});

test('exact decimals', () => {
  assert.equal(plainDecimal('1e-7'), '0.0000001');
  assert.equal(plainDecimal('1.5E+3'), '1500');
  assert.equal(plainDecimal('007.500'), '7.5');
  assert.equal(plainDecimal('-1'), undefined);
  assert.equal(multiplyDecimal('104.016', '0.9250'), '96.2148');
  assert.equal(multiplyDecimal('0.1', '0.2'), '0.02');
  assert.equal(multiplyDecimal('0', '0.5'), '0');
  assert.equal(roundDecimal('9.995', 2), '10');
  assert.equal(roundDecimal('0.004', 2), '0');
  assert.equal(roundDecimal('1.25', 1), '1.3');
  assert.equal(roundDecimal('99.99', 0), '100');
});
