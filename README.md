# Intempt Node.js SDK

Server-side Node.js client for the [Intempt](https://intempt.com) analytics platform.

## Installation

```bash
npm install intempt
```

## Quick Start

```typescript
import { SDK as IntemptSDK } from 'intempt';

const intempt = new IntemptSDK('my-org', 'my-project', 'api-key', 'source-id');

// Track a custom event
await intempt.track('prof_123', 'purchase', { amount: 99.99, currency: 'USD' });

// Identify a user
await intempt.identify('prof_123', 'john@example.com', null, { name: 'John', plan: 'pro' });
```

## Constructor

```typescript
new IntemptSDK(orgName, projectName, apiKey, sourceId, time?, maxSize?)
```

| Parameter     | Type     | Required | Description                                      |
|---------------|----------|----------|--------------------------------------------------|
| `orgName`     | `string` | Yes      | Your Intempt organization name                   |
| `projectName` | `string` | Yes      | Your Intempt project name                        |
| `apiKey`      | `string` | Yes      | API key from your Intempt source                 |
| `sourceId`    | `string` | Yes      | Source identifier                                |
| `time`        | `number` | No       | Flush interval in milliseconds                   |
| `maxSize`     | `number` | No       | Maximum events to buffer before flushing         |

## Methods

### Event Tracking

#### `track(profileId, eventTitle, data)`

Track a custom event.

```typescript
await intempt.track('prof_123', 'purchase', { amount: 99.99, currency: 'USD' });
```

#### `identify(profileId, userId, eventTitle?, userAttributes?)`

Identify a user across sources.

```typescript
await intempt.identify('prof_123', 'john@example.com', null, { name: 'John', plan: 'pro' });
```

#### `group(profileId, accountId, eventTitle?, accountAttributes?)`

Associate a profile with an account.

```typescript
await intempt.group('prof_123', 'acme-corp', null, { industry: 'SaaS', plan: 'enterprise' });
```

#### `record(profileId, eventTitle, userId?, accountId?, data?, userAttributes?, accountAttributes?)`

Send a fully specified event with all optional fields.

```typescript
await intempt.record('prof_123', 'signup', 'john@example.com', 'acme-corp', { source: 'landing-page' });
```

#### `alias(profileId, userId, anotherUserId)`

Link two user identifiers to the same profile.

```typescript
await intempt.alias('prof_123', 'john@example.com', 'john.doe@newdomain.com');
```

### Consent Management (GDPR/CCPA)

#### `consent(profileId, action, category, expirationTime?, email?, message?)`

Record consent for a specific category.

```typescript
await intempt.consent('prof_123', 'accept', 'advertising', '2025-12-31');
```

#### `consents(profileId, action, expirationTime?, email?, message?)`

Record a blanket consent decision (accept or reject all).

```typescript
await intempt.consents('prof_123', 'accept');
```

### Product Events

#### `productAdd(profileId, productId, quantity)`

Track a product added to cart.

```typescript
await intempt.productAdd('prof_123', 'sku-001', 2);
```

#### `productView(profileId, productId)`

Track a product page view.

```typescript
await intempt.productView('prof_123', 'sku-001');
```

#### `productOrdered(profileId, products)`

Track a completed order.

```typescript
await intempt.productOrdered('prof_123', [
  { productId: 'sku-001', quantity: 2 },
  { productId: 'sku-002', quantity: 1 },
]);
```

### Recommendations

#### `recommendation(profileId, id, quantity, fields, productId?)`

Fetch product recommendations.

```typescript
const recs = await intempt.recommendation('prof_123', 'rec-model-1', 5, ['name', 'price']);
```

### Experiments and Personalizations

#### `chooseExperimentsByGroups(profileId, groups?)`

Select experiment variants by group.

```typescript
const variants = await intempt.chooseExperimentsByGroups('prof_123', ['pricing-test']);
```

#### `chooseExperimentsByNames(profileId, names?)`

Select experiment variants by name.

```typescript
const variants = await intempt.chooseExperimentsByNames('prof_123', ['header-color-test']);
```

#### `choosePersonalizationsByGroups(profileId, groups?)`

Select personalizations by group.

#### `choosePersonalizationsByNames(profileId, names?)`

Select personalizations by name.

### Privacy Controls

#### `optIn()`

Resume event tracking after a previous opt-out.

#### `optOut()`

Stop all event tracking. Events are silently discarded until `optIn()` is called.

## Batching

Events are queued in memory and flushed to Intempt in batches. Flush behavior depends on the constructor parameters:

- **No `time` or `maxSize`**: events are sent immediately (no batching).
- **`time`**: events flush after the specified interval (milliseconds).
- **`maxSize`**: events flush when the buffer reaches the specified size.
- **Both**: events flush on whichever condition is met first.

```typescript
// Flush every 10 seconds or every 100 events, whichever comes first
const intempt = new IntemptSDK('my-org', 'my-project', 'api-key', 'source-id', 10000, 100);
```

## Requirements

- Node.js 14+
- TypeScript support included (ships with type declarations)

## License

[MIT](LICENSE)
