import { Bot } from "grammy";
import {
  registerComposeHandlers,
  registerComposeInterceptor,
} from "./handlers/compose";
import type { HandlerDeps } from "./handlers/deps";
import { registerHistoryHandlers } from "./handlers/history";
import { presentPlan, registerPlanHandlers } from "./handlers/plan";
import {
  registerGitCommands,
  registerProjectHandlers,
} from "./handlers/projects";
import {
  createRunPipeline,
  registerQueueCallbacks,
  registerTextHandler,
} from "./handlers/run";
import {
  registerControlCommands,
  registerProviderCommands,
  registerSessionLifecycle,
} from "./handlers/session-commands";
import { registerTopicTitleHandlers } from "./handlers/topic-titles";
import { registerUploadHandlers } from "./handlers/uploads";
import { registerVerbosityCommand } from "./handlers/verbosity";

export { cleanupStaleState } from "./handlers/user-state";

/** Reply-keyboard buttons rewritten into the command they stand for. */
const buttonToCommand: Record<string, string> = {
  Projects: "/projects",
  History: "/history",
  Stop: "/stop",
  New: "/new",
  Compact: "/compact",
  Compose: "/compose",
};

/** Create and configure the bot */
export function createBot(
  token: string,
  allowedUserId: number,
  projectsDir: string
) {
  const bot = new Bot(token);

  // Access control middleware
  const botId = Number.parseInt(token.split(":")[0] ?? "", 10);
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id === botId) {
      return;
    }
    if (ctx.from.id !== allowedUserId) {
      console.log(
        `Auth rejected: from=${ctx.from.id} allowed=${allowedUserId}`
      );
      await ctx.reply("Telegram User is Unauthorized.");
      return;
    }
    await next();
  });

  bot.use((ctx, next) => {
    const message = ctx.message;
    if (message?.text && message.text in buttonToCommand) {
      const cmd = buttonToCommand[message.text];
      if (cmd) {
        message.text = cmd;
        message.entities = [
          { type: "bot_command", offset: 0, length: cmd.length },
        ];
      }
    }
    return next();
  });

  const deps: HandlerDeps = { bot, botId, projectsDir, token };
  const pipeline = createRunPipeline(deps, presentPlan);

  // Order matters: the topic-title bookkeeping claims the forum service
  // messages first, the compose interceptor must see a message before the typed
  // handlers do, and the typed text handler must be registered before the
  // upload handlers, exactly as they were when all of this lived in one file.
  registerTopicTitleHandlers(deps);
  registerComposeInterceptor(deps);
  registerVerbosityCommand(deps);
  registerProviderCommands(deps);
  registerProjectHandlers(deps);
  registerControlCommands(deps);
  registerGitCommands(deps);
  registerSessionLifecycle(deps, pipeline);
  registerComposeHandlers(deps, pipeline);
  registerHistoryHandlers(deps);
  registerQueueCallbacks(deps);
  registerPlanHandlers(deps, pipeline);
  registerTextHandler(deps, pipeline);
  registerUploadHandlers(deps, pipeline);

  return bot;
}
