import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isAllowedStudentEmail(email, domains) {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = email.slice(at + 1);
  return domains.some((allowed) => domain === allowed);
}

export function parseRoleEmails(value) {
  let input;
  try {
    input = JSON.parse(value || '{"admin":[],"rider":[],"canteen":{}}');
  } catch {
    throw new Error('ROLE_EMAILS must be valid JSON.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((role) => !['admin', 'rider', 'canteen'].includes(role))) {
    throw new Error('ROLE_EMAILS must contain only admin, rider, and canteen assignments.');
  }
  const assignments = { admin: [], rider: [], canteen: {} };
  const seen = new Set();
  const addAddresses = (addresses, role, canteenId = null) => {
    if (!Array.isArray(addresses)) throw new Error(`ROLE_EMAILS.${role} must be an array of email addresses.`);
    return addresses.map((address) => {
      const email = normalizeEmail(address);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) {
        throw new Error(`ROLE_EMAILS contains an invalid or duplicate address: ${email || '(empty)'}.`);
      }
      seen.add(email);
      return email;
    });
  };
  assignments.admin = addAddresses(Object.hasOwn(input, 'admin') ? input.admin : [], 'admin');
  assignments.rider = addAddresses(Object.hasOwn(input, 'rider') ? input.rider : [], 'rider');
  const canteens = Object.hasOwn(input, 'canteen') ? input.canteen : {};
  if (!canteens || typeof canteens !== 'object' || Array.isArray(canteens) ||
    Object.keys(canteens).some((canteenId) => !['MBA', 'IT', 'MC'].includes(canteenId))) {
    throw new Error('ROLE_EMAILS.canteen must map MBA, IT, or MC to email arrays.');
  }
  for (const [canteenId, addresses] of Object.entries(canteens)) {
    assignments.canteen[canteenId] = addAddresses(addresses, 'canteen');
  }
  return assignments;
}

export function configuredRole(email, roleEmails) {
  for (const [role, assignments] of Object.entries(roleEmails)) {
    if (role === 'canteen') {
      for (const [canteenId, addresses] of Object.entries(assignments)) {
        if (addresses.includes(email)) return { role, canteenId };
      }
    } else if (assignments.includes(email)) {
      return { role, canteenId: null };
    }
  }
  return null;
}

export function createOtp() {
  return String(randomInt(100000, 1000000));
}

export function hashSecret(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function secretsMatch(left, right) {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
