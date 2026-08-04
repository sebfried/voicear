# Security policy

## Supported versions

Voicear has not published a stable release yet. Security fixes target the latest commit on `main` only.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/sebfried/voicear/security/advisories/new). If that route is unavailable, email `seb@plan.ai` with a minimal description and reproduction.

Never include real OpenAI keys, agent tokens, private endpoint URLs, chat exports, photos, audio, or complete browser logs. Revoke any credential that may have been exposed before sending a redacted report.

## Documented trust boundary

Voicear is a frontend-only BYOK application for trusted personal browser profiles. A long-lived API key stored in browser storage is accessible to JavaScript running on the same origin; this is a documented deployment constraint, not a hidden secret boundary. Shared public deployments should mint short-lived OpenAI client secrets through a small trusted backend instead.
