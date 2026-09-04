/**
 * Muse stall watchdog for omo (senpi).
 *
 * cliproxy/muse-spark-1.3-contributor-free often dies mid-turn without a
 * clean HTTP error. Engine retry + fallbackChains cover hard errors; this
 * extension covers silent hangs on the main session.
 *
 * If the live model looks like muse-spark, the agent is not idle, and no
 * stream/tool activity arrives for STALL_MS, abort the turn and queue a
 * follow-up so fallback can take the same work.
 *
 * Disable: OMO_MUSE_WATCH=0
 * Tune:    OMO_MUSE_STALL_MS (default 40000)
 *
 * Use ctx.setInterval / ctx.setTimeout only. A raw timer throw tears down
 * the whole session.
 */

const MUSE_RE = /muse-spark/i;
const STALL_MS = parseDurationEnv("OMO_MUSE_STALL_MS", 40_000);
const TICK_MS = 5_000;
const COOLDOWN_MS = 60_000;
const MAX_TRIPS = 4;
const CONTINUE_PROMPT =
  "Previous model stalled with no stream activity. Continue the same task from where it stopped. Do not restart from scratch.";

function parseDurationEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return fallback;
  return parsed;
}

function enabled() {
  const raw = process.env.OMO_MUSE_WATCH;
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

function modelBlob(ctx) {
  try {
    const model = ctx.models?.current?.();
    if (!model) return "";
    return [model.id, model.provider, model.name, model.api]
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  }
}

function isMuse(ctx) {
  return MUSE_RE.test(modelBlob(ctx));
}

function notify(ctx, message, kind = "warning") {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  } catch {
    // rpc / headless
  }
}

export default function (pi) {
  if (!enabled()) return;

  pi.setLabel?.("muse-watch");

  pi.on("session_start", (_event, ctx) => {
    let lastActivity = Date.now();
    let lastTrip = 0;
    let trips = 0;
    let pending = false;

    const bump = () => {
      lastActivity = Date.now();
    };

    pi.on("message_update", bump);
    pi.on("message_start", bump);
    pi.on("after_provider_response", () => {
      bump();
      trips = 0;
    });
    pi.on("auto_retry_start", bump);
    pi.on("auto_retry_end", bump);
    pi.on("tool_execution_start", bump);
    pi.on("tool_execution_update", bump);
    pi.on("tool_execution_end", bump);
    pi.on("agent_start", bump);
    pi.on("turn_start", bump);

    ctx.setInterval(() => {
      if (pending) return;
      if (!isMuse(ctx)) return;
      if (typeof ctx.isIdle === "function" && ctx.isIdle()) return;
      if (trips >= MAX_TRIPS) return;

      const silent = Date.now() - lastActivity;
      if (silent < STALL_MS) return;
      if (Date.now() - lastTrip < COOLDOWN_MS) return;

      pending = true;
      lastTrip = Date.now();
      trips += 1;
      notify(
        ctx,
        `muse stalled ${Math.round(silent / 1000)}s — abort ${trips}/${MAX_TRIPS}`,
        "warning",
      );

      try {
        ctx.abort?.();
      } catch {
        pending = false;
        return;
      }

      ctx.setTimeout(() => {
        try {
          pi.sendUserMessage(CONTINUE_PROMPT, {
            deliverAs: "followUp",
            triggerTurn: true,
          });
        } catch {
          // follow-up is best effort
        } finally {
          bump();
          pending = false;
        }
      }, 1200);
    }, TICK_MS);
  });
}
