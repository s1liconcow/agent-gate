import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseUsd, fundsResult, normalizeOrigin, sanitizeText } from '../extension/policy.mjs';

test('USD uses exact integer cents and grouped amounts', () => {
  assert.equal(parseUsd('$12,480.72'), 1248072);
  assert.equal(parseUsd('0.10'), 10);
  assert.equal(parseUsd('1000'), 100000);
  assert.equal(parseUsd('-$10.25', {allowNegative:true}), -1025);
});
for (const input of ['1,00.00','12.3','1.234','1e6','NaN','Infinity','12 480,72','0.01 USD','012.00','Available: $10.00','$10.00 $20.00','-1.00']) {
  test(`reject ambiguous or unsupported amount: ${input}`, () => assert.throws(() => parseUsd(input)));
}
test('fees and user reserve are included without floating point', () => {
  assert.equal(fundsResult('0.30', 10, '0.10','0.10').sufficient_available_balance, true);
  assert.equal(fundsResult('250.00', 25000, '0.01').sufficient_available_balance, false);
  assert.equal(fundsResult('-1.00', 100).sufficient_available_balance, false);
});
test('result has no exact balance, account identifier, or amount', () => {
  const result = fundsResult('12480.72', 25000);
  assert.deepEqual(result, {sufficient_available_balance:true, assessment:'balance_only', transfer_executed:false});
  assert.ok(!JSON.stringify(result).includes('12480'));
  assert.throws(() => fundsResult('12.00', true));
});
test('origins are exact and securely normalized', () => {
  assert.equal(normalizeOrigin('https://example.com/page'), 'https://example.com');
  assert.equal(normalizeOrigin('https://EXAMPLE.com:443/a'), 'https://example.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:8080/demo.html'), 'http://127.0.0.1:8080');
  for(const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com','https://user:pass@example.com']) assert.throws(() => normalizeOrigin(url));
});
test('sensitive patterns are removed before the local model', () => {
  const value = sanitizeText('The transfer cleared.\nBalance: $12,480.72\nEmail: demo@example.com\nPassword: abc123\nAccount number: 987654321098\nVisit https://example.com/?token=secret');
  for(const needle of ['12,480.72','demo@example.com','abc123','987654321098','?token=secret']) assert.ok(!value.includes(needle));
  assert.ok(value.includes('The transfer cleared.'));
});
test('Unicode normalization defeats simple obfuscation', () => {
  assert.ok(!sanitizeText('Ｅｍａｉｌ: ｄｅｍｏ＠ｅｘａｍｐｌｅ．ｃｏｍ').includes('demo@example.com'));
});
test('extension has minimal site access and no session harvesting APIs', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(m.permissions, ['activeTab','scripting','storage']);
  assert.equal(m.manifest_version, 3);
  assert.equal(m.externally_connectable, undefined);
  assert.equal(m.content_scripts, undefined);
  assert.ok(!m.host_permissions.includes('<all_urls>'));
});
