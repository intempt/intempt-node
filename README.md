# Intempt - Node SDK

[Intempt](https://intempt.com/?utm_campaign=sdk&utm_medium=docs&utm_source=github) is a GrowthOS built for the needs of SAAS and eCommerce companies focusing to grow their customer LTV.
This is a library to facilitate tracking of anonymous and logged-in user traffic on your Node.js server.

## Contents:

* [1](https://github.com/intempt/sdk-node#installation-and-initialization) - Installation and Initialization 
* [2](https://github.com/intempt/sdk-node#identifying-visitors) - How to identify a user
* [3](https://github.com/intempt/sdk-node#recording-events) - Recording Events
* [4](https://github.com/intempt/sdk-node#create-custom-collections) - Create Custom Collections
* [5](https://github.com/intempt/sdk-node#batching) - Batching
* [6](https://github.com/intempt/sdk-node#get-apis) - Get APIs

## Installation and Initialization

Install our SDK which is an npm package by running 
```Javascript
    npm install @intempt/sdk
```

To update to the latest version, run

```Javascript
    npm install intempt-nodejs-source@latest
```

[Login](https://app.intempt.com) to Intempt and obtain your snippet from the [sources](https://app.intempt.com/sources) page:

### Import

How to import the whole sdk:

```javascript
    const IntemptSdk = require('@intempt/sdk');
```

Or

```typescript
    import * as IntemptSdk from '@intempt/sdk'
```

### Modules

The sdk composed of separated modules / API-s. Some of them are:

1. `CDPMetadata`: the Client Data Platform, where the client specific domain.
2. `Metric`: 
3. `PushSource`:

And there are generic generic components like `Configuration`, `ResponseError` or helpers like `EventRecorder` and `EventBatcher`.

### Configuration and Authorization

In order to use or SDK some configuration is necessery, like authorization. The SDK accepts a wide varioty of configuration parameters.

```typescript
interface ConfigurationParameters {
    basePath?: string; // override base path
    fetchApi?: FetchAPI; // override for fetch implementation
    middleware?: Middleware[]; // middleware to apply before/after fetch requests
    queryParamsStringify?: (params: HTTPQuery) => string; // stringify function for query strings
    username?: string; // parameter for basic security
    password?: string; // parameter for basic security
    apiKey?: string | ((name: string) => string); // parameter for apiKey security
    accessToken?: string | Promise<string> | ((name?: string, scopes?: string[]) => string | Promise<string>); // parameter for oauth2 security
    headers?: HTTPHeaders; //header params we want to use on every request
    credentials?: RequestCredentials; //value for the credentials param we want to use on each request
}
```


First, Authorization. Our library provide two ways:

A Simple bearer token (jwt) from login. This method higly dependent the `exp` (expiration), which can be from couple of minutes to days. This is not fit for a long running api. 

```typescript
const configuration = new IntemptSdk.Configuration({
    accessToken: 'eyJhbG....'
});
```

Every Source comes with a key.

```
d9371778-b7ab-4d1c-8929-d3ee58e216d3.081ad6c9-dee9-4e64-9384-4cf0ca41c079
```

```typescript
const configuration = new IntemptSdk.Configuration({
    username:'d9371778-b7ab-4d1c-8929-d3ee58e216d3',
    password:'081ad6c9-dee9-4e64-9384-4cf0ca41c079'
})
```

### An API call

With the set up configuration, our api is avaliable. This example show how to list the sources.

```typescript
const sourcesApi = new IntemptSdk.CDPMetadata.SourcesApi(configuration);

await sourcesApi.fetchSources({orgName: orgName, projectName: projectName});
```

About ```

`flushAt`: This has a value of number. This has a default value of `10`. This determines how many items can be stored in memory at a time. For example, if you have `flushAt` set at `1`, this means we can only have one event at a time in our batch memory. 

`flushInterval`: This has a value of number. This has a default value of `10000ms`. This determines how long our memory should hold data before `flushing` to Intempt Servers.. For example, if you have `flushInterval` set at `10000ms`, this means we can only store events for as long as `10 seconds` in our batch memory. 

# Identifying Users

Our SDK provides an exported function to automatically track users. To track a user, all you have to do is to call the function below

```javascript
	Intempt.profile({profileId: profileId, user_identifier: user_identifier, account_identifier: account_identifier})
```

`profileId` : This is a profile Identifier which is used to identify users. ```Note```: In your server, it is advisable to use the Id of your users as profileId. That way, it is always unique and you don't need to have a randomizer or generator.

`user_identifier` : User identifier helps to identify users across all sources in your organization. This could be the user's email and so on. Eg. `example@example.com`


# Recording Events

Our server-side API allows creation of any event type you might desire to be tracked for your page or application.

Custom collections allow you to bring custom data into your organization.

# Create Custom Collections
After creating a NodeJS source, switch tabs to the schema and you should see a `profile` and `consents` collections already created. To start tracking custom events for our organization, after creating a [source](https://app.intempt.com/sources) you intend to use on your server, navigate to schema then use the schema Builder to create a collection with your personalized fields. Make sure to add a profileId field and set a profile identifier as one of its properties. [See intempt docs for keys and identifiers](https://dev.intempt.com/#keys-and-identifiers) to find out why.

Set up other custom field properties that match the data you plan to track.

Our SDK by default has a few exported functions for certain event tracking such as `profile`, `trackConsents` . You can log a custom event by calling Intempt's recordEvent function, passing in a set of key-value pairs.


```javascript
    Intempt.recordEvent('COLLECTION_NAME', event);
```

The COLLECTION_NAME refers to an event type. For example, if you wanted to track every time your server received a purchase request, you might call collection "purchase". Then, when a purchase happens, you call track and pass in the purchase details.

### Example

```javascript
	Intempt.recordEvent("purchase", {
		 "items": [{"item name": "item 1","price": 20}, {"item name": "item 2","price": 15}],
		 "totalprice": 35,
		 "ispaid": true,
		 "timestamp": new Date().getTime(),
		 "fixed.name": "John Smith",
		 "fixed.age": 28,
		 "intempt.visit.trackcharge": 35
	})
```

In the example above, we have a custom collection with name of `purchase`, then we have an object of key-value pairs. The Object passed into represent the fields we created while creating the collection. 

`NB`: Data type sent should match data type set when creating the collection. For instance, We are sending a field `timestamp` which has a data type of `number`, Sending data with a type of `string` instead of `number` will make this custom collection not get tracked

There are other examples in the `samples` directory.

# Tracking Consents

Save user consents and apply them to data flow. Make sure you have created consents purposes in your organization's settings


### Supported Regulation Types - GDPR & CCPA;

Consents are tracked using Intempt's exported function ;

```javascript
	Intempt.trackConsents(consents)
```

`Intempt.trackConsents()` expects consents as an array of Objects inorder to be tracked successfully. 
Example: 

```typescript
    er.trackConsents(
      "bob",
      [
        {
          regulation: 'GDPR',
          purpose: 'advertising',
          consented: true
        }, {
          regulation: 'CCPA',
          purpose: 'advertising',
          consented: true
        }
      ]
    );
```

Consents can contain as much as possible depending on your use case.

# Batching

Our libraries are built to support high-performance environments. That means it is safe to use our Node library on a web server that’s serving hundreds of requests per second.

Every method you call does not result in an HTTP request, but is queued in memory instead. Messages are then flushed in batch in the background, which allows to perform much faster operations.


```typescript
const eventRecorder = IntemptSdk.EventRecorder.WithEventBatcher(
    orgName,
    projectName,
    sourceId,
    new IntemptSdk.PushSource.SourcesApi(configuration),
    { maximum:100, interval: 10 });
```

# Get APIs
Below is a detailed list of functions our SDK makes available to be used in your server.


