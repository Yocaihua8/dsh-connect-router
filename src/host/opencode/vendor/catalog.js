// Normalize the OpenCode provider catalog into entries the adapter and the
// settings card both understand.
//
// Two shapes matter here. OpenCode reports capabilities it may not actually
// serve (a model declares `attachment: true` for a gateway that rejects images),
// and custom providers routinely omit `limit` entirely. DSH rejects a zero
// context window as invalid metadata and aborts the whole route, so a missing
// or zero limit must be replaced rather than passed through.

/** Fallbacks used when a provider omits capacity, which custom providers do. */
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT = 8192;

/** Reasoning effort levels OpenCode exposes as `variant` keys. */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Clamp one model's capacity into values DSH accepts.
 *
 * A model whose output cap meets or exceeds its context window is unusable
 * metadata: the caller would reserve the whole window for the reply.
 *
 * @param entry - `{ contextWindow, maxOutput }` possibly empty or zero.
 * @returns `{ contextWindow, maxOutput }` with `maxOutput < contextWindow`.
 */
export function safeLimits(entry) {
  const rawContext = Number(entry?.contextWindow);
  const rawOutput = Number(entry?.maxOutput);
  const contextWindow =
    Number.isFinite(rawContext) && rawContext > 0 ? Math.floor(rawContext) : DEFAULT_CONTEXT_WINDOW;
  let maxOutput = Number.isFinite(rawOutput) && rawOutput > 0 ? Math.floor(rawOutput) : DEFAULT_MAX_OUTPUT;
  if (maxOutput >= contextWindow) maxOutput = Math.max(1, Math.floor(contextWindow / 2));
  return { contextWindow, maxOutput };
}

/** Map one OpenCode model onto the normal form, or `undefined` if unusable. */
function normalizeModel(model, provider, route) {
  if (!isObject(model) || typeof model.id !== "string" || model.id.length === 0) return undefined;
  if (model.status === "deprecated") return undefined;
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  // A model that cannot emit text cannot answer a chat turn at all.
  if (capabilities.output?.text === false) return undefined;

  const limit = isObject(model.limit) ? model.limit : {};
  const { contextWindow, maxOutput } = safeLimits({
    contextWindow: limit.context,
    maxOutput: limit.output,
  });

  const input = isObject(capabilities.input) ? capabilities.input : {};
  const variants = isObject(model.variants) ? model.variants : {};
  const reasoningEfforts = Object.keys(variants).filter((key) => EFFORT_LEVELS.includes(key));
  const cost = isObject(model.cost) ? model.cost : {};
  const cacheCost = isObject(cost.cache) ? cost.cache : {};
  const knownPrice = typeof cost.input === "number" && Number.isFinite(cost.input) && cost.input >= 0 && typeof cost.output === "number" && Number.isFinite(cost.output) && cost.output >= 0;
  const free = knownPrice &&
    (Number(cost.input) || 0) === 0 &&
    (Number(cost.output) || 0) === 0 &&
    (Number(cacheCost.read) || 0) === 0 &&
    (Number(cacheCost.write) || 0) === 0;

  return {
    id: model.id,
    providerID: provider.id,
    providerName: provider.name ?? provider.id,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
    contextWindow,
    maxOutput,
    inputText: input.text !== false,
    inputImage: input.image === true,
    // Absent capability means "assume capable", matching protocol.supportsTools:
    // custom providers routinely omit `capabilities`, and reading that as
    // "no tools" would reject every tool-carrying turn for them.
    toolCall: capabilities.toolcall === true,
    reasoningEfforts,
    variants,
    cost: {
      input: Number(cost.input) || 0,
      output: Number(cost.output) || 0,
      cacheRead: Number(cacheCost.read) || 0,
      cacheWrite: Number(cacheCost.write) || 0,
    },
    free,
    priceKnown: knownPrice,
    route,
    apiNpm: model.api?.npm,
    apiUrl: model.api?.url,
  };
}

/**
 * Turn one `GET /provider` response into the flat catalog.
 *
 * Only `connected` providers are included. That is the whole point of the
 * field: OpenCode ships a catalog of 200+ providers it knows about, and the
 * overwhelming majority are not signed in and would fail on first use.
 *
 * @param providersResponse - the raw `{ all, default, connected }` body.
 * @param options.enabledModelIds - allow-list; EMPTY means every model. An
 *   empty allow-list meaning "nothing" would leave a fresh install showing no
 *   models at all, which reads as broken.
 * @param options.directProviders - `Map<providerID, {…}>` of providers reachable
 *   without the bridge; those models are additionally exposed on the direct
 *   route.
 * @returns normalized entries, bridge entries first.
 */
export function normalizeCatalog(providersResponse, options = {}) {
  const { enabledModelIds = [], directProviders = new Map() } = options;
  const all = Array.isArray(providersResponse?.all) ? providersResponse.all : [];
  const connected = Array.isArray(providersResponse?.connected)
    ? new Set(providersResponse.connected)
    : new Set();
  const allow = Array.isArray(enabledModelIds) ? new Set(enabledModelIds) : new Set();
  const entries = [];

  for (const provider of all) {
    if (!isObject(provider) || typeof provider.id !== "string") continue;
    if (!connected.has(provider.id)) continue;
    const models = isObject(provider.models) ? provider.models : {};
    const direct = directProviders.get(provider.id);
    for (const model of Object.values(models)) {
      const bridgeEntry = normalizeModel(model, provider, "bridge");
      if (!bridgeEntry) continue;
      if (allow.size > 0 && !allow.has(bridgeEntry.id) && !allow.has(`${provider.id}/${bridgeEntry.id}`)) {
        continue;
      }
      entries.push(bridgeEntry);
      // A direct route needs a protocol the adapter can dispatch on; without
      // one the model is still reachable, just through the bridge only.
      if (direct?.protocol) {
        entries.push({ ...bridgeEntry, route: "direct", directProtocol: direct.protocol, directUrl: direct.apiUrl });
      }
    }
  }

  // Stable order: provider, then model name. The picker renders in this order
  // and an unstable one makes the same catalog look different between refreshes.
  entries.sort((left, right) => {
    if (left.providerID !== right.providerID) return left.providerID.localeCompare(right.providerID);
    return left.name.localeCompare(right.name);
  });
  return entries;
}

/** Models that cost nothing, across every connected provider. */
export function freeModels(providersResponse) {
  return normalizeCatalog(providersResponse, { enabledModelIds: [] }).filter(
    (entry) => entry.free && entry.route === "bridge",
  );
}

/**
 * The live catalog.
 *
 * Mutable on purpose: the adapter builds its model list from `current()` on
 * every read, so a refresh becomes visible without rebuilding the adapter or
 * re-registering the route.
 */
export class Catalog {
  constructor(entries = []) {
    this.entries = entries;
  }

  current() {
    return this.entries;
  }

  set(entries) {
    this.entries = Array.isArray(entries) ? entries : [];
    return this.entries;
  }
}
