import type { RouterModel, SourceId } from "../shared/types.js";
const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const limit = (v: unknown): number | undefined => {
  const n = number(v);
  return n && Number.isInteger(n) ? n : undefined;
};
export function workbuddyModel(raw: {
  id: string;
  name?: string;
  creditMultiplier?: number;
  contextWindow?: number;
  maxTokens?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  reasoning?: {
    canDisableThinking?: boolean;
    supportedEfforts?: readonly string[];
  };
  unavailable?: string;
}): RouterModel {
  const price = number(raw.creditMultiplier);
  return {
    id: raw.id,
    source: "workbuddy",
    name: raw.name || raw.id,
    cost: price === undefined ? "unknown" : price === 0 ? "free" : "credits",
    contextWindow: limit(raw.contextWindow),
    maxOutput: limit(raw.maxTokens),
    tools: raw.supportsToolCall === true,
    images: raw.supportsImages === true,
    reasoning: !!raw.reasoning,
    reasoningCanDisable: raw.reasoning?.canDisableThinking === true,
    reasoningEfforts: raw.reasoning?.supportedEfforts,
    unavailable: raw.unavailable,
    input: raw.supportsImages ? ["text", "image"] : ["text"],
    output: ["text"],
  };
}
export function opencodeModels(response: any): RouterModel[] {
  const connected = new Set(
    Array.isArray(response?.connected) ? response.connected : [],
  );
  return (Array.isArray(response?.all) ? response.all : []).flatMap((p: any) =>
    Object.values(p.models ?? {}).flatMap((m: any) => {
      if (typeof m?.id !== "string") return [];
      const input = number(m.cost?.input),
        output = number(m.cost?.output),
        cache = [m.cost?.cache?.read, m.cost?.cache?.write];
      const known =
        input !== undefined &&
        output !== undefined &&
        cache.every((v) => v === undefined || number(v) !== undefined);
      const free =
        known &&
        input === 0 &&
        output === 0 &&
        cache.every((v) => v === undefined || v === 0);
      const modalities = (value: any) =>
        Object.entries(value ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k);
      const outputs = modalities(m.capabilities?.output);
      return [
        {
          id: `${p.id}/${m.id}`,
          upstreamId: `${p.id}/${m.id}`,
          service: p.id,
          source: "opencode" as SourceId,
          name: m.name || m.id,
          cost: !known
            ? ("unknown" as const)
            : free
              ? ("free" as const)
              : ("paid" as const),
          contextWindow: limit(m.limit?.context),
          maxOutput: limit(m.limit?.output),
          tools: m.capabilities?.toolcall === true,
          images: m.capabilities?.input?.image === true,
          reasoning: m.capabilities?.reasoning === true,
          reasoningCanDisable: false,
          input: modalities(m.capabilities?.input),
          output: outputs,
          unavailable: !connected.has(p.id)
            ? "AUTH_REQUIRED"
            : m.status === "deprecated"
              ? "MODEL_DEPRECATED"
              : outputs.some((x) => x !== "text") ||
                  m.capabilities?.output?.text === false
                ? "NATIVE_OUTPUT_NOT_SUPPORTED"
                : undefined,
        },
      ];
    }),
  );
}
/** Publish only explicit selections; unknown prices cannot enter the free default. */
export function selectModels(
  models: RouterModel[],
  ids: readonly string[],
): RouterModel[] {
  return models.filter((m) => ids.includes(m.id));
}
