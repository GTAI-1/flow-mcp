// Guidance handed to the calling model through flow_status, so it plans scenes that Flow can actually run.
export const PLAYBOOK = {
  workflow: [
    "Call flow_status first. If it returns a hint, relay it to the user and stop.",
    "Plan the whole piece as scenes of one shot each, then send them in ONE flow_generate call so file numbering and chaining work.",
    "Tell the user the expected credit total before queueing anything that costs credits.",
    "Call flow_wait repeatedly until finished is true; scenes run one at a time with 25-70 s pauses.",
  ],
  models: {
    "Omni 1.1 Flash": "7 credits at 4s, 12 at 8s (720p). Supports duration 4/6/8/10 and 360p/720p. Best default for drafts and frame-to-frame transitions.",
    "Veo 3.1 - Lite": "10 credits, fixed 8s.",
    "Veo 3.1 - Fast": "20 credits, fixed 8s.",
    "Veo 3.1 - Quality": "100 credits, fixed 8s. Needs max_credits raised explicitly.",
    "Nano Banana 2": "Images, 0 credits. Use it to make keyframes and product stills before spending on video.",
  },
  prompt_order: "subject and action -> shot size and camera move -> location -> visual style -> lighting -> sound/dialogue",
  prompt_rules: [
    "Write prompts in English, one continuous shot per scene, one camera move per scene.",
    "Name the camera behaviour explicitly (static locked-off, slow push-in, orbit, crane up, handheld).",
    "Repeat the full description of a recurring character or product in every scene; Flow has no memory between scenes.",
    "Put spoken lines in quotes and say who speaks; keep a line short enough for the clip length.",
    "For 9:16 social video set aspect_ratio on every scene.",
  ],
  continuity: [
    "chain_previous: true starts a scene on the last frame of the scene before it, giving one continuous take across clips.",
    "first_frame + last_frame makes Flow animate between two stills; generate both stills as free images first for controlled transitions.",
    "reference_images (max 3) keep a product or person consistent without fixing the first frame.",
  ],
};
