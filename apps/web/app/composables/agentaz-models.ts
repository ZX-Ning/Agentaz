import type { ModelSetRequest, ModelStateResponse } from "../../types/protocol";
import {
  isDraftSessionId,
  modelKey,
  sessionUrl,
  isThinkingLevel,
} from "../utils/app.util";
import type { AgentazContext } from "./agentaz-state";
import type { AgentazApi } from "./agentaz-api";

/**
 * Model and thinking-level selection handlers.
 *
 * For draft sessions the choice is applied to local state only (it is replayed
 * during draft materialisation); for real sessions it is persisted to the
 * backend and the response folded back via `applyModelState`.
 */
export function createAgentazModels(ctx: AgentazContext, api: AgentazApi) {
  const { agentFetch, applyModelState, updateThinkingState } = api;

  async function handleModelSelect(value: unknown) {
    const sessionId = ctx.activeSessionId.value;
    if (!sessionId || typeof value !== "string") return;
    const option = ctx.modelOptions.value.find((item) => item.value === value);
    if (!option || modelKey(option.model) === ctx.selectedModelKey.value)
      return;
    if (isDraftSessionId(sessionId)) {
      const state = ctx.ensureModelState(sessionId);
      state.currentModel = option.model;
      state.pendingModelChange = false;
      updateThinkingState(
        sessionId,
        state.thinkingLevel,
        option.model.availableThinkingLevels,
      );
      return;
    }

    const body: ModelSetRequest = {
      provider: option.model.provider,
      id: option.model.id,
    };
    applyModelState(
      await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/model"), {
        method: "PUT",
        body,
      }),
    );
  }

  async function handleThinkingSelect(value: unknown) {
    const sessionId = ctx.activeSessionId.value;
    if (!sessionId || !isThinkingLevel(value)) return;
    if (isDraftSessionId(sessionId)) {
      updateThinkingState(sessionId, value);
      return;
    }
    applyModelState(
      await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/thinking"), {
        method: "PUT",
        body: { level: value },
      }),
    );
  }

  return { handleModelSelect, handleThinkingSelect };
}

export type AgentazModels = ReturnType<typeof createAgentazModels>;
