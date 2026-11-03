// models · zh-CN：模型选择器（components/model-picker.js）
export default {
  /** 认不出的模型族 */
  otherFamily: "其他",
  /** 模态类型 tab（文本/图片/视频/语音/其他）；0 个模型的 tab 不渲染 */
  tab: {
    text: "文本",
    image: "图片",
    video: "视频",
    voice: "语音",
    other: "其他",
  },
  /** tab 上的可用数：{ok} 可用 */
  tabAvail: "{ok} 可用",
  /** tab 上的可用数（有未知项）：{ok} 可用 / {unk} 未知 */
  tabAvailUnknown: "{ok} 可用 / {unk} 未知",
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
  /** 明显不能对话的模型不再隐藏，只加一行提示（见 model-picker.js） */
  maybeNonChat: "可能不支持对话",
  /** 价格目录（公开、无鉴权）没拿到时显示，不能留空白 */
  pricingUnavailable: "价格信息暂不可用。参考价来自站点的公开价格目录，只作参考，实际扣费以账单为准",
  /** 能力表（model-profiles）没拿到：视觉/工具/推理是「未知」，不是「不支持」——徽章的缺席不能让客户当结论 */
  capsUnknown: "站点没有提供服务能力信息：下面没有标「视觉 / 工具 / 推理」的模型是**未知**，不是不支持",
  /** 模型在站上存在，但这把 Key 所在的分组没开：照样列出来，客户才知道该找站主开什么 */
  notInKeyGroup: "当前分组不含此模型",
  /** 不可用模型折叠段的标题（默认折叠，点击展开） */
  blockedHead: "本站还有 {count} 个模型不在你的分组里（展开查看）",
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
