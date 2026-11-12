# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `createNetChaos()` / `NetChaos` with an explicit, instance-bound `fetch()` wrapper (never patches global `fetch`).
- Five built-in profiles: `fast`, `slow-3g`, `unstable`, `high-latency`, `offline`.
- Custom `latency` and `failureRate` overrides, validated, persisted across `setProfile()`; `clearOverrides()`.
- Per-request configuration snapshot, so runtime profile switches never affect in-flight requests.
- AbortSignal support during simulated latency, with native `init.signal` / `Request.signal` precedence.
- `SimulatedNetworkError` (extends `TypeError`, stable `code`), `NetChaosConfigError`, `NetChaosError`.
- Project scaffolding: TypeScript, tsup, Vitest, ESLint, Prettier.
