#!/usr/bin/env node

const REQUIRED_ENV_VARS = [
  'SHOPIFY_STORE_URL',
  'SHOPIFY_ADMIN_ACCESS_TOKEN',
  'SHOPIFY_API_VERSION',
  'MCP_SHARED_SECRET',
];

function fail(message) {
  console.error(`Shopify connection test failed: ${message}`);
  process.exit(1);
}

function normalizeStoreHost(storeUrl) {
  const trimmed = (storeUrl || '').trim();

  if (!trimmed) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  return parsed.hostname;
}

async function main() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    fail(`missing required environment variable(s): ${missing.join(', ')}`);
  }

  let storeHost;

  try {
    storeHost = normalizeStoreHost(process.env.SHOPIFY_STORE_URL);
  } catch (_error) {
    fail('SHOPIFY_STORE_URL is not a valid store URL or hostname');
  }

  if (!storeHost) {
    fail('SHOPIFY_STORE_URL is empty');
  }

  const apiVersion = process.env.SHOPIFY_API_VERSION.trim();
  const endpoint = `https://${storeHost}/admin/api/${encodeURIComponent(apiVersion)}/graphql.json`;

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: 'query { shop { name myshopifyDomain } }',
      }),
    });
  } catch (_error) {
    fail('unable to reach Shopify Admin GraphQL API');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (_error) {
    fail(`Shopify returned HTTP ${response.status} with a non-JSON response`);
  }

  if (!response.ok) {
    const firstError = Array.isArray(payload.errors) && payload.errors[0]?.message
      ? payload.errors[0].message
      : response.statusText || 'request was not successful';

    fail(`Shopify returned HTTP ${response.status}: ${firstError}`);
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0]?.message || 'GraphQL error returned';
    fail(firstError);
  }

  const shop = payload.data?.shop;

  if (!shop?.name || !shop?.myshopifyDomain) {
    fail('Shopify response did not include expected shop data');
  }

  console.log('Shopify connection test passed. Shopify is connected.');
}

main().catch(() => {
  fail('unexpected error while testing Shopify connection');
});
