// Secret redaction applied to every prompt before it is stored or printed.

const PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi,
];
const KEY_VALUE = /\b(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)(\s*[:=]\s*)\S+/gi;
// Plain-language passwords ("pass 123qweasD", "password is hunter2"): only values containing a digit.
const SPOKEN_PASSWORD = /\b(password|passwd|pwd|pass)(\s+(?:is\s+)?)(?=\S*\d)\S+/gi;
const TAIL = [
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+\/]{40,}={0,2}/g,
  // A bare password typed on its own ("bob 123qweasD"): 8+ chars mixing lower case, upper case and digits.
  /(?<![\w./@-])(?=[\w!#$%&*]*[a-z])(?=[\w!#$%&*]*[A-Z])(?=[\w!#$%&*]*\d)[\w!#$%&*]{8,64}(?![\w./@-])/g,
];

const MASK = '[REDACTED]';

/** Replace API keys, tokens, JWTs and `password=…` values with [REDACTED]. */
export function redact(text) {
  let out = String(text ?? '');
  for (const re of PATTERNS) out = out.replace(re, MASK);
  out = out.replace(KEY_VALUE, (_, key, sep) => `${key}${sep}${MASK}`);
  out = out.replace(SPOKEN_PASSWORD, (_, key, sep) => `${key}${sep}${MASK}`);
  for (const re of TAIL) out = out.replace(re, MASK);
  return out;
}

/** Prompt text as stored in events: redacted, at most 2000 chars (redacted before cutting so no secret is half-kept). */
export const promptText = (text) => redact(String(text ?? '').slice(0, 4000)).slice(0, 2000);
