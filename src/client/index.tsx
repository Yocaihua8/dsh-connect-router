import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import { TYPERT_REMOTE } from "../../lib/typert.remote-client.js";
import { RouterClient } from "./controller.js";
import { RouterSettingsPage } from "./settings.js";
import { RecoveryNotice, type RecoveryBinding } from "./recovery.js";
import { CONTINUE_PROMPT } from "../shared/types.js";
import styles from "./style.css";

export const inject = ["remote", "slots"];
export async function apply(ctx: Context) {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE);
  const ui = ctx.inject(["remote.connectRouter", "slots"], (scope) => {
    const client = new RouterClient(scope.remote.connectRouter);
    const style = document.createElement("style");
    style.dataset.dshPlugin = "dsh-connect-router";
    style.textContent = styles;
    document.head.append(style);
    scope.effect(() => () => {
      client.dispose();
      style.remove();
    });
    scope.slots.inject("settings.section", () =>
      scope.slots.register(
        {
          name: "settings.section",
          id: "dsh-connect-router",
          order: 36,
          label: () => "Connect Router",
          inject: () => ({ client }),
        },
        RouterSettingsPage,
      ),
    );
    scope.inject(
      ["conversation", "sessions", "uiSession", "modelDirectories"],
      (features) => {
        features.slots.inject("conversation.composer.dock", () =>
          features.slots.register(
            {
              name: "conversation.composer.dock",
              id: "dsh-connect-router-recovery",
              order: 45,
              inject: (sessionId) => {
                const session = features.sessions.binding(sessionId)!;
                const directory =
                  features.modelDirectories.directoryFor(sessionId);
                const binding: RecoveryBinding = {
                  id: sessionId,
                  rpc: features.remote.connectRouter,
                  running: () =>
                    features.uiSession.sessionStatus
                      .getSnapshot()
                      .get(sessionId)?.running !== false,
                  matches: (value) => {
                    const current = directory.store.getSnapshot().current;
                    return (
                      current?.provider === value.provider &&
                      current.model === value.model
                    );
                  },
                  send: () => session.ctx.conversation.send(CONTINUE_PROMPT),
                  subscribe: (listener) => {
                    const stops = [
                      features.uiSession.sessionStatus.subscribe(listener),
                      directory.store.subscribe(listener),
                    ];
                    return () => stops.forEach((stop) => stop());
                  },
                };
                return { binding };
              },
            },
            RecoveryNotice,
          ),
        );
      },
    );
  });
  try {
    await ui;
  } catch (e) {
    await ui.dispose();
    await unmount();
    throw e;
  }
  return async () => {
    await ui.dispose();
    await unmount();
  };
}
