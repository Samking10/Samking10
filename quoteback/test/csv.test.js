import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, readEstimatesCsv, parseDate } from '../src/csv.js';
import { tsToDateInput } from '../src/time.js';

const TZ = 'America/Chicago';

test('parses quoted fields, commas, escaped quotes and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('reads US and ISO dates with 2- and 4-digit years', () => {
  assert.equal(tsToDateInput(parseDate('10/20/2026', TZ), TZ), '2026-10-20');
  assert.equal(tsToDateInput(parseDate('3/4/26', TZ), TZ), '2026-03-04');
  assert.equal(tsToDateInput(parseDate('2026-01-05', TZ), TZ), '2026-01-05');
  assert.equal(parseDate('', TZ), null);
  assert.equal(parseDate('next week', TZ), undefined);
});

test('maps common column names and flags bad rows', () => {
  const now = Date.UTC(2026, 10, 9, 18);
  const { rows, missing } = readEstimatesCsv(
    'First Name,Last Name,Email Address,Quote Total,Scope,Estimate Date\nAva,Brooks,ava@example.com,"$3,200.50",bathroom,10/20/2026\nBo,,nope,12,x,2026-10-01\n', TZ, now);
  assert.deepEqual(missing, []);
  assert.equal(rows[0].input.customer_name, 'Ava Brooks');
  assert.equal(rows[0].input.amount, '$3,200.50');
  assert.equal(rows[0].errors.length, 0);
  assert.match(rows[1].errors.join(' '), /valid customer email/);
});

test('reports missing required columns', () => {
  const { missing } = readEstimatesCsv('foo,bar\n1,2\n', TZ);
  assert.deepEqual(missing, ['customer name', 'email']);
});
