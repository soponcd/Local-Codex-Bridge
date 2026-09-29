const TEXT_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*([^\s,;]+)/gi,
    "$1=[REDACTED]",
  ],
  [
    /\b([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET))\s*=\s*([^\s,;]+)/gi,
    "$1=[REDACTED]",
  ],
];

export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/g, "").toLowerCase();
  return [
    "apikey",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "password",
    "passwd",
    "secret",
    "clientsecret",
    "secretaccesskey",
    "cookie",
    "setcookie",
    "credential",
    "privatekey",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

export function redactText(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of TEXT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

// Detectors must not retain the replacement regexes' global lastIndex state.
const SECRET_DETECTORS = TEXT_SECRET_PATTERNS.map(([pattern]) =>
  new RegExp(pattern.source, pattern.flags.replaceAll("g", "")));

export function hasSecretText(value: string): boolean {
  return SECRET_DETECTORS.some(pattern => pattern.test(value));
}
