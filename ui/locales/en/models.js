// models · en: model picker (components/model-picker.js)
export default {
  otherFamily: "Other",
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
  /** Models that obviously can't chat are hidden by default; this switch lists them with a marker */
  showAllCount: "Show all models ({count} hidden)",
  showAllOn: "Show all models (on)",
  maybeNonChat: "may not support chat",
  /** Shown when the public pricing catalog can't be fetched — never leave the price area blank */
  pricingUnavailable: "Pricing is unavailable right now. Reference prices come from the site's public catalog; they're indicative only — your bill is what counts",
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
