export const defaults = Object.freeze({
  title: 'The room remembers',
  lyrics: '[Verse]\nThe room remembers every sound\nA quiet ocean underground\nI leave a light beside the door\nFor who I used to be before\n\n[Chorus]\nLet it turn, let it glow\nLet the night move soft and slow',
  style: 'English, atmospheric art pop, intimate vocals, warm analog synthesizers, slow breakbeat, melancholic, spacious reverb',
  cot: 'off', abc: '', seed: '', num_inference_steps: 32, cfg_scale: 1.01,
  abc_temperature: 0.7, abc_top_p: 0.9, abc_top_k: 30,
  abc_repetition_penalty: 1.005, abc_penalty_window: 100, abc_min_tokens: 32, abc_max_tokens: 4096,
  semantic_temperature: 1, semantic_top_p: 0.95, semantic_top_k: 100,
  semantic_repetition_penalty: 1.2, semantic_penalty_window: 50, semantic_min_tokens: 200, semantic_max_tokens: 1125,
  backend: 'vulkan', threads: 8, weight_storage: 'q8_0', wait_for_memory: true,
});

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Expected a generation request.');
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new ApiError(400, `Unknown setting: ${key}.`);
  const result = { ...defaults, ...input };
  for (const [key, max, required] of [['title', 160, false], ['lyrics', 12000, true], ['style', 2000, true], ['abc', 64000, false]]) {
    if (typeof result[key] !== 'string' || result[key].length > max || result[key].includes('\0')) throw new ApiError(400, `${key} must be text of at most ${max} characters, without null characters.`);
    result[key] = result[key].trim();
    if (required && !result[key]) throw new ApiError(400, `Add ${key} before generating.`);
  }
  if (!['off', 'melody', 'full'].includes(result.cot)) throw new ApiError(400, 'Planning must be off, melody, or full.');
  if (result.abc && result.cot === 'off') throw new ApiError(400, 'Enable melody or melody + chords planning to use an ABC score.');
  if (!['vulkan', 'cpu'].includes(result.backend)) throw new ApiError(400, 'Backend must be vulkan or cpu.');
  if (!['q8_0', 'native'].includes(result.weight_storage)) throw new ApiError(400, 'GPU memory mode must be efficient Q8 or original storage.');
  if (typeof result.wait_for_memory !== 'boolean') throw new ApiError(400, 'Wait for memory must be on or off.');
  if (typeof result.seed !== 'string' || (result.seed !== '' && !/^\d{1,19}$/.test(result.seed))) throw new ApiError(400, 'Seed must be a non-negative integer written as text, or empty for random.');
  if (result.seed !== '' && BigInt(result.seed) >= 2n ** 63n) throw new ApiError(400, 'Seed must be less than 9223372036854775808.');
  const number = (key, min, max, integer = false, exclusiveMin = false) => {
    const value = result[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || (exclusiveMin ? value <= min : value < min) || value > max || (integer && !Number.isInteger(value))) {
      throw new ApiError(400, `${key} must be ${integer ? 'an integer' : 'a number'} ${exclusiveMin ? 'greater than' : 'at least'} ${min} and at most ${max}.`);
    }
  };
  number('threads', 1, 32, true);
  number('num_inference_steps', 1, 100, true);
  number('cfg_scale', 0, 20);
  for (const prefix of ['abc', 'semantic']) {
    number(`${prefix}_temperature`, 0, 5, false, true);
    number(`${prefix}_top_p`, 0, 1, false, true);
    number(`${prefix}_top_k`, 1, 100000, true);
    number(`${prefix}_repetition_penalty`, 0, 100, false, true);
    number(`${prefix}_penalty_window`, 1, 100000, true);
    number(`${prefix}_min_tokens`, 0, prefix === 'abc' ? 4096 : 9000, true);
    number(`${prefix}_max_tokens`, 1, prefix === 'abc' ? 4096 : 9000, true);
    if (result[`${prefix}_max_tokens`] < result[`${prefix}_min_tokens`]) throw new ApiError(400, `${prefix}_max_tokens must be at least ${prefix}_min_tokens.`);
  }
  return result;
}
