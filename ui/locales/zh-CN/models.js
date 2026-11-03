// models · zh-CN：模型选择器（components/model-picker.js）
export default {
  /** 认不出的模型族 */
  otherFamily: "其他",
  caps: {
    vision: "视觉",
    tools: "工具",
    reasoning: "推理",
  },
  /** 按次计费的参考价，price 形如 $0.04 */
  perCall: "{price}/次",
  noteTitle: "上下文 · 能力 · 每百万 tokens 输入/输出的起步参考价（美元，以账单为准）",
  choose: "选择模型",
  filter: "筛选模型",
  filterOrId: "筛选，或输入任意模型 ID",
  loadFailed: "获取模型列表失败：{error}",
  useCustom: "使用「{id}」",
  customId: "自定义模型 ID",
  none: "没有可用模型：这个 Key 所在的分组还没有开放模型",
  /** 明显不能对话的模型默认隐藏；打开这一档后它们会带着标记一起列出来 */
  showAllCount: "显示全部模型（已隐藏 {count} 个）",
  showAllOn: "显示全部模型（已开）",
  maybeNonChat: "可能不支持对话",
  /** 价格目录（公开、无鉴权）没拿到时显示，不能留空白 */
  pricingUnavailable: "价格信息暂不可用。参考价来自站点的公开价格目录，只作参考，实际扣费以账单为准",
  /** 选择器的两个滑块 */
  tiers: {
    value: "性价比",
    strategy: {
      low_cost: "省钱",
      balanced: "均衡",
      stable: "质量",
    },
    intelligence: "模型智能",
    /** 第二个滑块的档名，从省到强 */
    level: {
      min: "最低",
      low: "低",
      medium: "中",
      high: "高",
      max: "最高",
    },
    custom: "自定义",
    valueText: "{level}：{model}",
    cheaper: "更省",
    smarter: "更强",
    allModels: "全部模型",
    back: "返回",
    reset: "恢复默认",
    /** aa 是指向 Artificial Analysis 的链接 */
    foot: "沿帕累托前沿选择模型，数据来自 {aa}",
  },
};
