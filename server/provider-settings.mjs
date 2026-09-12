import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError} from './validation.mjs';

const providers = ['ollama', 'deepinfra', 'openai'];
export function validateOllamaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, 'Enter an Ollama address such as http://127.0.0.1:11434.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new ApiError(400, 'Use the local Ollama server on localhost, 127.0.0.1, or [::1], with no path or credentials.');
  }
  return url.origin;
}

export async function createProviderSettings({dataRoot, secretStorage, environment = process.env, managedOllama}) {
  const filename = path.join(dataRoot, 'providers.json');
  let disk = {};
  try { disk = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Provider settings could not be read. Your keys have not been changed.'); }
  const savedBase = disk.ollamaBaseUrl;
  let baseUrl = validateOllamaUrl(managedOllama && (!savedBase || savedBase === managedOllama.previousUrl) ? managedOllama.url : savedBase || 'http://127.0.0.1:11434');
  const encryptedKeys = {...(disk.encryptedKeys || {})}, sessionKeys = new Map();
  const secureStorage = Boolean(secretStorage?.isAvailable());
  const envKey = provider => provider === 'openai' ? environment.OPENAI_API_KEY : provider === 'deepinfra' ? (environment.DEEPINFRA_API_KEY || environment.DEEPINFRA_TOKEN) : '';
  async function getKey(provider) {
    if (sessionKeys.has(provider)) return sessionKeys.get(provider);
    if (encryptedKeys[provider]) {
      if (!secureStorage) throw new ApiError(503, 'Open the desktop app to unlock this saved API key, or enter a key for this session.');
      try { return await secretStorage.decrypt(encryptedKeys[provider]); } catch { throw new ApiError(503, 'This saved API key could not be unlocked. Enter it again in provider settings.'); }
    }
    return envKey(provider) || '';
  }
  function publicSettings() {
    const states = {ollama: {configured: true}};
    for (const provider of ['deepinfra', 'openai']) {
      const source = sessionKeys.has(provider) ? 'session' : encryptedKeys[provider] ? 'saved' : envKey(provider) ? 'environment' : 'none';
      states[provider] = {configured: source !== 'none', source};
    }
    return {ollamaBaseUrl: baseUrl, providers: states, secureStorage, recommendedLocalModel:managedOllama ? 'granite4.2:3b' : undefined};
  }
  async function update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !providers.includes(input.provider)) throw new ApiError(400, 'Choose Ollama, DeepInfra, or OpenAI.');
    const allowed = input.provider === 'ollama' ? ['provider', 'baseUrl'] : ['provider', 'apiKey'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(400, 'Unknown provider setting.');
    const nextEncrypted = {...encryptedKeys};
    let nextBase = baseUrl, nextSession;
    if (input.provider === 'ollama') nextBase = validateOllamaUrl(input.baseUrl);
    else {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n\x00]/.test(input.apiKey)) throw new ApiError(400, 'Enter a valid API key.');
      const key = input.apiKey.trim();
      if (!key) delete nextEncrypted[input.provider];
      else if (secureStorage) nextEncrypted[input.provider] = await secretStorage.encrypt(key);
      else nextSession = key;
    }
    // Only ciphertext is ever persisted; a plain Node server uses memory for new keys.
    const temporary = filename + '.' + randomUUID() + '.tmp';
    await fs.mkdir(dataRoot, {recursive:true});
    await fs.writeFile(temporary, JSON.stringify({version:1, ollamaBaseUrl:nextBase, encryptedKeys:nextEncrypted}, null, 2), {mode:0o600});
    await fs.rename(temporary, filename);
    baseUrl = nextBase;
    for (const key of Object.keys(encryptedKeys)) delete encryptedKeys[key];
    Object.assign(encryptedKeys, nextEncrypted);
    if (input.provider !== 'ollama') {
      sessionKeys.delete(input.provider);
      if (nextSession) sessionKeys.set(input.provider, nextSession);
    }
    return publicSettings();
  }
  return {getKey, publicSettings, update, getOllamaBaseUrl: () => baseUrl};
}
