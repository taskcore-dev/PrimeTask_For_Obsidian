# Security

## Scope

This repository contains the public source for the PrimeTask Obsidian plugin.

The plugin talks only to a locally running PrimeTask desktop app over `127.0.0.1`. The desktop app remains the main security boundary for:

- user approval
- token issuance
- token revocation
- space locking and scoped access
- trusted vs unsigned build verification

## Reporting a security issue

Please do **not** open a public GitHub issue for suspected security vulnerabilities.

Instead, report security concerns privately to TaskCore LTD through the support or contact channel listed on:

- https://primetask.app

When reporting, include:

- plugin version
- PrimeTask desktop version
- operating system
- clear reproduction steps
- logs or screenshots if relevant

## Signed and unsigned builds

Official PrimeTask builds may sign auth requests so the desktop app can identify them as trusted.

Unsigned builds or forks may still be visible to PrimeTask as `Unknown source`, depending on the user's approval flow and desktop app policy.

## Secrets policy

Private signing keys must never be committed to this repository.

- Local development may use a local private key file that is gitignored.
- Official release signing should use CI secrets.
- Public source and public release metadata must not expose private keys.
