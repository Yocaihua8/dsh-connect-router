import type {
  ModelSettings,
  RouterModel,
  SourceSettings,
} from "../shared/types.js";

export function settingsFor(
  settings: SourceSettings,
  model: RouterModel,
): ModelSettings {
  return (
    settings.models?.[model.id] ?? {
      enabled:
        settings.enabledModels.includes(model.id) ||
        (!!model.upstreamId &&
          model.region !== "global" &&
          settings.enabledModels.includes(model.upstreamId)),
      context:
        settings.contextBudget && model.contextWindow
          ? {
              mode: "custom",
              tokens: Math.min(settings.contextBudget, model.contextWindow),
            }
          : { mode: "auto" },
      capabilities: {},
      allowedCosts: ["free", "credits"],
    }
  );
}
export function configuredModel(
  model: RouterModel,
  settings: ModelSettings,
): RouterModel {
  const caps = settings.capabilities;
  if (caps.reasoning === false && model.reasoning && !model.reasoningCanDisable)
    throw new Error("REASONING_CANNOT_DISABLE");
  if (
    settings.context.mode === "custom" &&
    (!model.contextWindow || settings.context.tokens > model.contextWindow)
  )
    throw new Error("CONTEXT_LIMIT_UNCONFIRMED");
  return {
    ...model,
    contextWindow:
      settings.context.mode === "custom"
        ? settings.context.tokens
        : model.contextWindow,
    tools: model.tools && caps.tools !== false,
    images: model.images && caps.images !== false,
    reasoning: model.reasoning && caps.reasoning !== false,
  };
}

// Compare saved behavior, independent of object key and cost-list order.
export function sameModelSettings(a: ModelSettings, b: ModelSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.context.mode === b.context.mode &&
    (a.context.mode !== "custom" ||
      (b.context.mode === "custom" && a.context.tokens === b.context.tokens)) &&
    (["tools", "images", "reasoning"] as const).every(
      (cap) => (a.capabilities[cap] !== false) === (b.capabilities[cap] !== false),
    ) &&
    JSON.stringify([...new Set(a.allowedCosts ?? ["free", "credits"])].sort()) ===
      JSON.stringify([...new Set(b.allowedCosts ?? ["free", "credits"])].sort())
  );
}

export function validateModelChange(
  model: RouterModel,
  previous: ModelSettings,
  next: ModelSettings,
) {
  if (model.unavailable) {
    if (!sameModelSettings(previous, next))
      throw new Error("UNAVAILABLE_MODEL_CHANGED");
    return;
  }
  configuredModel(model, next);
}
