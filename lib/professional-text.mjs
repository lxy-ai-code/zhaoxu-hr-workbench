// Shared professional-material projection. Kept independent of prompt registries
// so scene policies can use it without importing the reply-analysis workflow.
export const privateProfessionalStatement = /性别|男性|女性|男士|女士|(?:^|[：:\s])(?:男|女)(?:$|[，,\s])|身份证|年龄|\d{2}\s*岁|婚育|已婚|未婚|怀孕|备孕|生育|民族|种族|宗教|残疾|残障|病史|疾病|骨折|手术|健康状况|血型|身高|体重|家庭情况|户籍|户口|国籍/;
export function professionalPriorityText(value, max = 12000) {
  return String(value ?? '').split(/(?<=[。！？!?；;])|\r?\n/).filter(line => !privateProfessionalStatement.test(line)).join('\n')
    .replace(/\b\d{17}[\dXx]\b/g, '[身份信息已省略]').replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, '[联系方式已省略]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[联系方式已省略]').trim().slice(0, max);
}
