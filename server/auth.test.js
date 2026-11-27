import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredRole, createOtp, hashSecret, isAllowedStudentEmail, normalizeEmail, parseRoleEmails, secretsMatch } from './auth.js';

test('student email matching requires the exact configured domain', () => {
  const domains = ['cb.students.amrita.edu'];
  assert.equal(isAllowedStudentEmail('person@cb.students.amrita.edu', domains), true);
  assert.equal(isAllowedStudentEmail('person@sub.cb.students.amrita.edu', domains), false);
  assert.equal(isAllowedStudentEmail('person@cb.students.amrita.edu.example.com', domains), false);
  assert.equal(isAllowedStudentEmail('person@gmail.com', domains), false);
});

test('email normalization is stable and rejects non-string values', () => {
  assert.equal(normalizeEmail('  Person@CB.Students.Amrita.edu '), 'person@cb.students.amrita.edu');
  assert.equal(normalizeEmail(null), '');
});

test('role assignments bind staff emails to server-configured roles', () => {
  const roles = parseRoleEmails('{"admin":["OPS@amrita.edu"],"rider":[],"canteen":{"MBA":["mba@amrita.edu"]}}');
  assert.deepEqual(configuredRole('ops@amrita.edu', roles), { role: 'admin', canteenId: null });
  assert.deepEqual(configuredRole('mba@amrita.edu', roles), { role: 'canteen', canteenId: 'MBA' });
  assert.equal(configuredRole('student@cb.students.amrita.edu', roles), null);
});

test('role configuration rejects invalid or conflicting assignments', () => {
  assert.throws(() => parseRoleEmails('not-json'), /valid JSON/);
  assert.throws(() => parseRoleEmails('{"admin":["a@amrita.edu"],"rider":["a@amrita.edu"]}'), /duplicate address/);
  assert.throws(() => parseRoleEmails('{"admin":null}'), /must be an array/);
  assert.throws(() => parseRoleEmails('{"canteen":{"OUTSIDE":["a@amrita.edu"]}}'), /map MBA, IT, or MC/);
});

test('OTP generation and hashing preserve comparison safety', () => {
  const otp = createOtp();
  assert.match(otp, /^\d{6}$/);
  const digest = hashSecret(otp, 'test-secret');
  assert.equal(secretsMatch(digest, hashSecret(otp, 'test-secret')), true);
  assert.equal(secretsMatch(digest, hashSecret('000000', 'test-secret')), false);
  assert.equal(secretsMatch('not-hex', digest), false);
});
