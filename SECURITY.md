# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/OpenCMO-AI/opencmo/security/advisories/new)
(Security tab → "Report a vulnerability"), or email **support@opencmo.io** with the subject
line "Security".

Include what you found, how to reproduce it, and the impact you expect. We will acknowledge
your report within 3 business days and keep you updated until it is resolved. Please give us
a reasonable time to fix the issue before disclosing it publicly; we are happy to credit you
in the advisory.

## Scope

In scope: this repository and the hosted service at opencmo.io — for example authentication
and authorization (RLS, RPC ownership checks, API keys), credit and billing logic, file
upload and storage access, and server-side media processing (ffmpeg, the exporter, Lottie and
3D rendering).

Out of scope: denial of service through volume, social engineering, and issues in third-party
services (Supabase, Vercel, Modal, AI providers) that are not caused by how OpenCMO uses them.

## Supported versions

Only the latest commit on `main` and the current hosted version receive security fixes.
