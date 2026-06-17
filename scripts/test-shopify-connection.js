#!/usr/bin/env node

const dns = require('node:dns/promises');

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

function getSafeErrorDetails(error) {
  const details = [];

  if (error?.name) {
    details.push(`name=${error.name}`);
  }

  if (error?.code) {
    details.push(`code=${error.code}`);
  }

  if (error?.message) {
    details.push(`message=${error.message}`);
  }

  if (error?.cause?.code) {
    details.push(`cause.code=${error.cause.code}`);
  }

  if (error?.cause?.message) {
    details.push(`cause.message=${error.cause.message}`);
  }

  return details.length > 0 ? details.join('; ') : 'no additional error details available';
}

async function checkDnsReachability(storeHost) {
  try {
    await dns.lookup(storeHost);
    console.log('DNS/network reachability check: host resolved successfully.');
  } catch (error) {
    console.error(`DNS/network reachability check failed: ${getSafeErrorDetails(error)}`);
  }
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
  const endpointPath = `/admin/api/${encodeURIComponent(apiVersion)}/graphql.json`;
  const endpoint = `https://${storeHost}${endpointPath}`;

  console.log(`Normalized Shopify host: ${storeHost}`);
  console.log(`Final Shopify Admin API path: ${endpointPath}`);

  await checkDnsReachability(storeHost);

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
  } catch (error) {
    fail(`unable to reach Shopify Admin GraphQL API (${getSafeErrorDetails(error)})`);
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

main().catch((error) => {
  fail(`unexpected error while testing Shopify connection (${getSafeErrorDetails(error)})`);
});
