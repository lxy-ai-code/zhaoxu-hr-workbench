import { sensitiveCriterion } from './criteria.mjs';

// Shipped business defaults. Saved templates are the source of truth at runtime.
export const DEFAULT_EVALUATION_RULES = Object.freeze({
  conversation_priority: {
    dimensions: [
      { key: 'role_relevance', label: '岗位职业证据', maxPoints: 50 },
      { key: 'conversation_need', label: '沟通待办明确度', maxPoints: 30 },
      { key: 'next_step', label: '下一步可执行性', maxPoints: 20 },
    ],
    thresholds: { high: 75, normal: 45 },
  },
  sourcing_match: {
    dimensions: [
      { key: 'role_relevance', label: '岗位职业证据', maxPoints: 80 },
      { key: 'intent_alignment', label: '求职意向对齐', maxPoints: 20 },
    ],
    thresholds: { high: 75, normal: 45 },
  },
  interview_report: {
    dimensions: [
      { key: 'answer_quality', label: '回答与解决问题质量', weight: 40 },
      { key: 'role_fit', label: '岗位经验适配', weight: 40 },
      { key: 'intent_alignment', label: '求职意愿与安排匹配', weight: 20 },
    ],
  },
});

const fail = message => Object.assign(new Error(message), { code: 'invalid_evaluation_rules', statusCode: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));

export function normalizeEvaluationRules(scene, rules) {
  const defaults = DEFAULT_EVALUATION_RULES[scene];
  if (!defaults) {
    if (rules != null) throw fail('此分析环节没有数字评分设置，请修改分析规则正文。');
    return null;
  }
  if (rules == null) return structuredClone(defaults);
  const report = scene === 'interview_report';
  if (!exact(rules, report ? ['dimensions'] : ['dimensions', 'thresholds']) || !Array.isArray(rules.dimensions) || rules.dimensions.length !== defaults.dimensions.length) throw fail('评分设置的维度数量或字段不正确。');
  const valueKey = report ? 'weight' : 'maxPoints';
  const seen = new Set();
  for (const row of rules.dimensions) {
    if (!exact(row, ['key', 'label', valueKey]) || !defaults.dimensions.some(item => item.key === row.key) || seen.has(row.key)) throw fail('评分维度标识不正确或重复，请保留系统的维度标识。');
    seen.add(row.key);
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.trim().length > 60 || /[<>\r\n\p{Cc}]/u.test(row.label) || sensitiveCriterion.test(row.label)) throw fail('维度名称应为60字以内的岗位相关文字，不能包含私人属性或技术标记。');
    if (!Number.isInteger(row[valueKey]) || row[valueKey] < 1 || row[valueKey] > 100) throw fail('每项权重或分值上限必须是1到100的整数。');
  }
  if (rules.dimensions.reduce((sum, row) => sum + row[valueKey], 0) !== 100) throw fail('各维度权重或分值上限合计必须为100。');
  const normalized = {
    dimensions: defaults.dimensions.map(item => {
      const row = rules.dimensions.find(value => value.key === item.key);
      return { key: row.key, label: row.label.trim(), [valueKey]: row[valueKey] };
    }),
  };
  if (!report) {
    const threshold = rules.thresholds;
    if (!exact(threshold, ['high', 'normal']) || !Number.isInteger(threshold.high) || !Number.isInteger(threshold.normal) || threshold.normal < 0 || threshold.high > 100 || threshold.high <= threshold.normal) throw fail('优先级分界必须为0到100的整数，且高优先级大于普通优先级。');
    normalized.thresholds = { high: threshold.high, normal: threshold.normal };
  }
  return normalized;
}

export function evaluationRulesFor(prompt = {}) {
  return normalizeEvaluationRules(prompt.scene, prompt.evaluationRules);
}

export function evaluationInstructions(scene, rules) {
  const normalized = normalizeEvaluationRules(scene, rules);
  if (!normalized) return '';
  const values = normalized.dimensions.map(row => `${row.key}「${row.label}」${scene === 'interview_report' ? `权重${row.weight}%` : `0–${row.maxPoints}分`}`).join('；');
  return scene === 'interview_report'
    ? `本模板评分设置：${values}。score为0–100或null；weight使用本模板权重，weightedScore=score×weight/100。只有全部维度有足够证据时才合计totalScore，否则totalScore=null；scoredWeight为已评维度权重之和，未知不补零。`
    : `本模板评分设置：${values}。各项points为整数，maxPoints使用本模板上限，总分为各项之和。高优先级分界${normalized.thresholds.high}分，普通优先级分界${normalized.thresholds.normal}分，其余为低优先级；证据不足时score=null、dimensions=[]，不把未知当0分。`;
}
