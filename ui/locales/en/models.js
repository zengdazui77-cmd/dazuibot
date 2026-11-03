// models · en: model picker (components/model-picker.js)
export default {
  otherFamily: "Other",
  /** Modality tabs (text/image/video/voice/other); a tab with zero models isn't rendered */
  tab: {
    text: "Text",
    image: "Image",
    video: "Video",
    voice: "Voice",
    other: "Other",
  },
  /** Availability count on a tab: {ok} available */
  tabAvail: "{ok} available",
  /** Availability count with unknowns: {ok} available / {unk} unknown */
  tabAvailUnknown: "{ok} available / {unk} unknown",
  caps: {
    vision: "Vision",
    tools: "Tools",
    reasoning: "Reasoning",
  },
  perCall: "{price}/call",
  noteTitle: "Context · Capabilities · Starting reference price per million tokens, input/output (USD; your bill is final)",
  choose: "Choose model",
  filter: "Filter models",
  filterOrId: "Filter, or enter any model ID",
  loadFailed: "Couldn't load models: {error}",
  useCustom: "Use “{id}”",
  customId: "Custom model ID",
  none: "No models available: this key's group doesn't have any models enabled yet",
  /** Models that obviously can't chat are no longer hidden; they just get a note (see model-picker.js) */
  maybeNonChat: "may not support chat",
  /** Shown when the public pricing catalog can't be fetched — never leave the price area blank */
  pricingUnavailable: "Pricing is unavailable right now. Reference prices come from the site's public catalog; they're indicative only — your bill is what counts",
  /** The capability table (model-profiles) is missing: vision/tools/reasoning are UNKNOWN, not unsupported */
  capsUnknown: "The site provides no capability data: a model without a Vision / Tools / Reasoning badge is unknown, not unsupported",
  /** The model exists on the site but this key's group does not include it: list it so the user knows what to ask for */
  notInKeyGroup: "not in this key's group",
  notInKeyGroupCount: "{count} of these are not in this key's group and will fail if picked; switch groups on the site or ask the site owner for access",
  /** Header of the collapsed "unavailable models" section */
  blockedHead: "{count} more models on the site are not in your group (expand to view)",
  tiers: {
    value: "Value",
    strategy: {
      low_cost: "Cheap",
      balanced: "Balanced",
      stable: "Quality",
    },
    intelligence: "Intelligence",
    level: {
      min: "Lowest",
      low: "Low",
      medium: "Medium",
      high: "High",
      max: "Highest",
    },
    custom: "Custom",
    valueText: "{level}: {model}",
    cheaper: "Cheaper",
    smarter: "Smarter",
    allModels: "All models",
    back: "Back",
    reset: "Reset",
    foot: "Pareto-optimal models, data from {aa}",
  },
};
