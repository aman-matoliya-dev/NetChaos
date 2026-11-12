# NetChaos

**Break your network before it breaks your application.**

NetChaos is a Fetch-level network condition simulator for browser and Node.js applications. It helps developers test how their applications behave under slow, unstable, and unavailable network conditions.

NetChaos works through an explicit Fetch wrapper. It does not modify or monkey-patch global `fetch`.

## Features

- Simulate slow and unreliable network conditions.
- Inject artificial latency and request failures.
- Switch network profiles at runtime.
- Configure custom latency and failure rates.
- Test offline behavior.
- Support browser and Node.js Fetch APIs.
- Preserve native Fetch `AbortSignal` behavior.
- Use independent NetChaos instances.
- No automatic retries or global network modifications.

## Installation

```bash
npm install netchaos
```

**Requirements:** Node.js 18 or later, or a browser environment with Fetch API support.

## Quick Start

```javascript
import { createNetChaos } from "netchaos";

const chaos = createNetChaos({
  profile: "slow-3g",
});

// Use chaos.fetch instead of global fetch.
try {
  const response = await chaos.fetch("https://api.example.com/users");
  const data = await response.json();

  console.log(data);
} catch (error) {
  console.error("Request failed:", error);
}
```

NetChaos only affects requests made through `chaos.fetch()`.

## Built-in Network Profiles

NetChaos provides five built-in profiles.

| Profile        | Base latency | Failure rate | Description                                |
| -------------- | -----------: | -----------: | ------------------------------------------ |
| `fast`         |         0 ms |           0% | Healthy network                            |
| `slow-3g`      |      2000 ms |           0% | Slow mobile network                        |
| `unstable`     |       800 ms |          30% | Variable latency and intermittent failures |
| `high-latency` |      3000 ms |           0% | Consistently high latency                  |
| `offline`      |         0 ms |         100% | Immediate simulated failure                |

### Profile behavior

- `fast`: No additional latency or simulated failures.
- `slow-3g`: Adds a fixed 2000 ms latency.
- `unstable`: Uses an 800 ms base latency, with internal jitter of up to ±600 ms, and a 30% failure probability.
- `high-latency`: Adds a fixed 3000 ms latency.
- `offline`: Immediately rejects every request without forwarding it to the underlying Fetch implementation.

The jitter configuration is internal and is not part of the public API.

## Runtime Profile Switching

You can change the active profile without creating a new instance.

```javascript
import { createNetChaos } from "netchaos";

const chaos = createNetChaos({
  profile: "fast",
});

// Start testing with a slow network.
chaos.setProfile("slow-3g");

// Switch to an unstable network.
chaos.setProfile("unstable");

// Simulate complete network failure.
chaos.setProfile("offline");

// Restore a healthy network.
chaos.setProfile("fast");
```

Profile changes affect future requests. Requests already in progress retain the configuration they started with.

## Custom Network Conditions

You can override the latency and failure rate when creating an instance.

```javascript
const chaos = createNetChaos({
  profile: "fast",
  latency: 1500,
  failureRate: 0.2,
});
```

| Option        | Type     | Description                                                          |
| ------------- | -------- | -------------------------------------------------------------------- |
| `latency`     | `number` | Additional latency in milliseconds. Must be finite and non-negative. |
| `failureRate` | `number` | Probability of simulated failure, from `0` to `1`.                   |

Custom overrides replace the selected profile's corresponding values.

### Overrides persist across profile switches

```javascript
const chaos = createNetChaos({
  profile: "slow-3g",
  latency: 4000,
});

chaos.setProfile("fast");

// Custom latency remains 4000 ms.
console.log(chaos.getConfig());
```

### Clearing overrides

Use `clearOverrides()` to restore the active profile's default values.

```javascript
chaos.clearOverrides();
```

This affects future requests only.

**Offline exception:** The `offline` profile always fails immediately. Custom overrides cannot change its behavior. Previously configured overrides remain stored and can apply again after switching to another profile.

## API Reference

### `createNetChaos(options?)`

Creates and returns an independent NetChaos instance.

```javascript
const chaos = createNetChaos({
  profile: "unstable",
});
```

Equivalent to:

```javascript
import { NetChaos } from "netchaos";

const chaos = new NetChaos({
  profile: "unstable",
});
```

### `chaos.fetch(input, init?)`

A Fetch-compatible function that applies the active network conditions before forwarding surviving requests to the underlying Fetch implementation.

```javascript
const response = await chaos.fetch("/api/data");
```

### `chaos.setProfile(profile)`

Changes the active network profile.

```javascript
chaos.setProfile("high-latency");
```

Unknown profile names throw `NetChaosConfigError`.

### `chaos.clearOverrides()`

Removes custom latency and failure-rate overrides.

```javascript
chaos.clearOverrides();
```

### `chaos.getConfig()`

Returns the effective conditions currently applied to new requests.

```javascript
console.log(chaos.getConfig());
```

The returned configuration contains:

- `profile`
- `latency`
- `failureRate`

### `chaos.profile`

A read-only property containing the currently active profile.

```javascript
console.log(chaos.profile);
```

## Advanced Configuration

### Custom Fetch implementation

You can provide your own Fetch-compatible implementation.

```javascript
const chaos = createNetChaos({
  profile: "slow-3g",
  fetch: myCustomFetch,
});
```

If no custom implementation is provided, NetChaos captures the global Fetch implementation when the instance is created.

If no Fetch implementation is available, requests fail with `NetChaosConfigError`.

### Deterministic randomness

For testing, you can provide a custom random-number generator.

```javascript
const chaos = createNetChaos({
  profile: "unstable",
  random: () => 0.5,
});
```

The function must return a number in the range `[0, 1)`.

This allows predictable testing of jitter and simulated failure decisions.

## Error Handling

NetChaos exports the following error classes:

- `NetChaosError`
- `NetChaosConfigError`
- `SimulatedNetworkError`

Use them to distinguish configuration problems from simulated network failures.

```javascript
import { createNetChaos, NetChaosConfigError, SimulatedNetworkError } from "netchaos";

const chaos = createNetChaos({
  profile: "offline",
});

try {
  await chaos.fetch("/api/data");
} catch (error) {
  if (error instanceof NetChaosConfigError) {
    console.error("Invalid NetChaos configuration:", error.message);
  } else if (error instanceof SimulatedNetworkError) {
    console.error("Simulated network failure:", error.message);
  } else {
    console.error("Request error:", error);
  }
}
```

## AbortSignal Support

NetChaos supports Fetch request cancellation through `AbortSignal`.

```javascript
const controller = new AbortController();

const request = chaos.fetch("/api/data", {
  signal: controller.signal,
});

controller.abort();

try {
  await request;
} catch (error) {
  console.error("Request was aborted:", error);
}
```

Abort signals can cancel requests during simulated latency and are forwarded to the underlying Fetch implementation for actual network requests.

## Important Limitations

- NetChaos only affects requests explicitly made through `chaos.fetch()`.
- It does not modify global `fetch`.
- It does not simulate operating-system-level network failures.
- It does not change browser DevTools network conditions.
- It does not automatically retry failed requests.
- It does not affect requests made through unrelated HTTP clients.
- Each instance maintains its own profile and configuration.

## TypeScript Support

NetChaos includes TypeScript declarations.

```typescript
import { createNetChaos, type NetworkProfile, type NetChaosConfig } from "netchaos";

const profile: NetworkProfile = "slow-3g";

const chaos = createNetChaos({ profile });

const config: NetChaosConfig = chaos.getConfig();

console.log(config);
```

## Development

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd netchaos
npm install
```

Run the available development checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

Run the complete check pipeline:

```bash
npm run check
```

Run tests with coverage:

```bash
npm run test:coverage
```

## License

MIT
