#!/usr/bin/env node

const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const IP_FAMILY = 4;

dns.setDefaultResultOrder('ipv4first');

const REQUIRED_ENV_VARS = [
  'SHOPIFY_STORE_URL',
  'SHOPIFY_ADMIN_ACCESS_TOKEN',
  'SHOPIFY_API_VERSION',
  'MCP_SHARED_SECRET',
];

function fail(message) {
  console.error(`Shopify connection test failed: ${redactSensitiveValues(message)}`);
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

function redactSensitiveValues(value) {
  let safeValue = String(value);

  for (const envVarName of REQUIRED_ENV_VARS) {
    const secretValue = process.env[envVarName];

    if (secretValue) {
      safeValue = safeValue.split(secretValue).join('[REDACTED]');
    }
  }

  return safeValue;
}

function pushSafeErrorDetail(details, label, value) {
  if (value) {
    details.push(`${label}=${redactSensitiveValues(value)}`);
  }
}

function getSafeErrorDetails(error) {
  const details = [];

  pushSafeErrorDetail(details, 'name', error?.name);
  pushSafeErrorDetail(details, 'code', error?.code || error?.cause?.code);
  pushSafeErrorDetail(details, 'message', error?.message || error?.cause?.message);

  return details.length > 0 ? details.join('; ') : 'no additional error details available';
}

async function checkDnsReachability(storeHost) {
  try {
    await dnsPromises.lookup(storeHost, { family: IP_FAMILY });
  } catch (error) {
    fail(`DNS/network reachability check failed (${getSafeErrorDetails(error)})`);
  }
}

function parseShopifyError(payload) {
  if (Array.isArray(payload?.errors) && payload.errors[0]?.message) {
    return payload.errors[0].message;
  }

  if (typeof payload?.errors === 'string') {
    return payload.errors;
  }

  if (payload?.error) {
    return typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error);
  }

  return '';
}

function getHttpsProxyUrl() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (!proxyUrl) {
    return null;
  }

  try {
    return new URL(proxyUrl);
  } catch (_error) {
    return null;
  }
}

function createProxyTunnel({ storeHost, proxyUrl }) {
  return new Promise((resolve, reject) => {
    const connectRequest = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 8080,
      method: 'CONNECT',
      path: `${storeHost}:443`,
      family: IP_FAMILY,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { ...options, family: IP_FAMILY }, callback);
      },
      headers: {
        Host: `${storeHost}:443`,
      },
    });

    connectRequest.setTimeout(30000, () => {
      connectRequest.destroy(Object.assign(new Error('proxy tunnel timed out'), { code: 'ETIMEDOUT' }));
    });

    connectRequest.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error('proxy tunnel failed'), { code: `HTTP_${response.statusCode}` }));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: storeHost,
      }, () => {
        resolve(tlsSocket);
      });

      tlsSocket.on('error', reject);
    });

    connectRequest.on('error', reject);
    connectRequest.end();
  });
}

class IPv4ProxyHttpsAgent extends https.Agent {
  constructor({ storeHost, proxyUrl }) {
    super();
    this.storeHost = storeHost;
    this.proxyUrl = proxyUrl;
  }

  createConnection(_options, callback) {
    createProxyTunnel({ storeHost: this.storeHost, proxyUrl: this.proxyUrl })
      .then((socket) => callback(null, socket), callback);
  }
}

function requestShopifyGraphql({ storeHost, endpointPath, token, body }) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);

    const proxyUrl = getHttpsProxyUrl();
    const requestOptions = {
      hostname: storeHost,
      path: endpointPath,
      method: 'POST',
      family: IP_FAMILY,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { ...options, family: IP_FAMILY }, callback);
      },
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'X-Shopify-Access-Token': token,
      },
    };

    if (proxyUrl) {
      requestOptions.agent = new IPv4ProxyHttpsAgent({ storeHost, proxyUrl });
    }

    const request = https.request(requestOptions, (response) => {
      let responseBody = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          body: responseBody,
        });
      });
    });

    request.setTimeout(30000, () => {
      request.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }));
    });

    request.on('error', reject);
    request.write(requestBody);
    request.end();
  });
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

  console.log(`Normalized Shopify host: ${storeHost}`);
  console.log(`IP family used: IPv${IP_FAMILY}`);

  await checkDnsReachability(storeHost);

  let response;

  try {
    response = await requestShopifyGraphql({
      storeHost,
      endpointPath,
      token: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      body: {
        query: 'query { shop { name myshopifyDomain } }',
      },
    });
  } catch (error) {
    fail(`unable to reach Shopify Admin GraphQL API (${getSafeErrorDetails(error)})`);
  }

  console.log(`HTTP status code: ${response.statusCode}`);

  let payload;

  try {
    payload = JSON.parse(response.body);
  } catch (_error) {
    fail(`Shopify returned HTTP ${response.statusCode} with a non-JSON response`);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const shopifyError = parseShopifyError(payload) || response.statusMessage || 'request was not successful';
    fail(`Shopify returned HTTP ${response.statusCode}: ${redactSensitiveValues(shopifyError)}`);
  }

  const shopifyError = parseShopifyError(payload);

  if (shopifyError) {
    fail(redactSensitiveValues(shopifyError));
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
