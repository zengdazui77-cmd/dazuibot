-- 修正：默认模式改为不限制（all），并救回「allowlist 但白名单为空」的死锁团队。
--
-- 背景：011 的列默认值是 'allowlist'。若某条代码路径插入策略行时未显式指定 mode，
-- 会得到 allowlist + 空名单，意味着该团队一个模型都用不了（成员发消息直接 409）。
-- 缺失策略行的团队按 'all' 处理（不限制），因此只有意外插入的行会踩到这个坑。
--
-- 1) 把列默认值改成 'all'，与「无策略行 = 不限制」的既有语义保持一致。
ALTER TABLE team_model_policies ALTER COLUMN mode SET DEFAULT 'all';

-- 2) 救回已经卡住的团队：allowlist 但白名单为空，本就无法使用任何模型。
--    放宽为 'all'，让团队恢复可用，而不是让所有成员都收到 409。
UPDATE team_model_policies SET mode='all' WHERE mode='allowlist' AND cardinality(allowed_models)=0;
