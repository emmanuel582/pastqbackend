/** Preserve valid international names and plus-addressed emails without changing passwords. */
export function authInput(body, { signup = false } = {}) {
  const { email, password, name } = body || {};
  if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new Error('Enter a valid email address.');
  }
  if (typeof password !== 'string' || password.length < (signup ? 8 : 1) || password.length > 128) {
    throw new Error(signup ? 'Use a password between 8 and 128 characters.' : 'Enter your password.');
  }
  if (signup && (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name))) {
    throw new Error('Enter your name using up to 120 characters.');
  }
  return { email: email.trim(), password, ...(signup ? { name: name.trim() } : {}) };
}
