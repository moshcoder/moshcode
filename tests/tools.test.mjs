import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency, generateId, debounce, deepClone, sleep, retry } from '../src/tools.mjs';

describe('formatCurrency', () => {
  it('formats USD by default', () => {
    assert.equal(formatCurrency(1234.56), '$1,234.56');
  });
  
  it('formats EUR', () => {
    assert.equal(formatCurrency(100, 'EUR'), '€100.00');
  });
  
  it('formats zero', () => {
    assert.equal(formatCurrency(0), '$0.00');
  });
});

describe('generateId', () => {
  it('generates id of specified length', () => {
    assert.equal(generateId(8).length, 8);
    assert.equal(generateId(16).length, 16);
  });
  
  it('generates different ids', () => {
    const id1 = generateId();
    const id2 = generateId();
    assert.notEqual(id1, id2);
  });
  
  it('only contains alphanumeric chars', () => {
    assert.match(generateId(100), /^[a-z0-9]+$/);
  });
});

describe('debounce', () => {
  it('delays function execution', async () => {
    let called = false;
    const fn = () => { called = true; };
    const debounced = debounce(fn, 50);
    debounced();
    assert.equal(called, false);
    await sleep(60);
    assert.equal(called, true);
  });
});

describe('deepClone', () => {
  it('creates a deep copy', () => {
    const original = { a: 1, b: { c: 2 } };
    const clone = deepClone(original);
    clone.b.c = 3;
    assert.equal(original.b.c, 2);
    assert.equal(clone.b.c, 3);
  });
});

describe('sleep', () => {
  it('resolves after delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40); // Allow some timing tolerance
  });
});

describe('retry', () => {
  it('retries on failure', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'success';
    };
    const result = await retry(fn, 3, 10);
    assert.equal(result, 'success');
    assert.equal(attempts, 3);
  });
  
  it('throws after max attempts', async () => {
    const fn = async () => { throw new Error('always fail'); };
    await assert.rejects(() => retry(fn, 2, 10), /always fail/);
  });
});
