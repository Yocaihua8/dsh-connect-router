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
