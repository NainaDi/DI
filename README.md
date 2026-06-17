# DI

This repo is for Shopify/Codex Cloud work.

## Shopify connection test

This repository includes a safe Shopify Admin GraphQL connection test. The test runs only this query:

```graphql
query { shop { name myshopifyDomain } }
```

### Required environment variables

Set these environment variables before running the test. Do not commit real secret values to this repository.

- `SHOPIFY_STORE_URL`: Shopify store URL or host, with or without `https://`, and with or without a trailing slash.
- `SHOPIFY_ADMIN_ACCESS_TOKEN`: Shopify Admin API access token.
- `SHOPIFY_API_VERSION`: Shopify Admin API version, such as `2025-10`.
- `MCP_SHARED_SECRET`: Shared secret required by this repo's environment.

### Run the test

```sh
npm test
```

The test prints whether Shopify is connected. If it fails, it prints only a safe error message and does not print secret values.
