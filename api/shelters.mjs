import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  healthPayload,
  nearbyPayload,
  openShelterStore,
  searchPayload,
} from '../lib/shelter-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const store = openShelterStore(join(here, '..', 'prototype', 'data', 'heat-shelters.sqlite'));

function resultFor(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { statusCode: 400, body: { error: 'invalid_json', message: '요청 형식이 올바르지 않아요.' } };
  }
  if (payload.action === 'health') return healthPayload(store);
  if (payload.action === 'search') return searchPayload(store, payload);
  if (payload.action === 'nearby') return nearbyPayload(store, payload);
  return { statusCode: 400, body: { error: 'invalid_action', message: '지원하지 않는 요청이에요.' } };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed', message: 'POST 요청만 허용해요.' });
  }
  let payload = request.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return response.status(400).json({ error: 'invalid_json', message: '요청 형식이 올바르지 않아요.' });
    }
  }
  const result = resultFor(payload);
  return response.status(result.statusCode).json(result.body);
}
