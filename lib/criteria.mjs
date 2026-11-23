// Job-related criteria only. Source material can retain facts, but generated
// questions and communication advice must not turn personal attributes into
// employment screening criteria, including after an external Base edit.
export const sensitiveCriterion = /性别|男性|女性|男士|女士|男生|女生|只招[男女]|限[男女]|[男女]优先|已婚|未婚|已育|未育|婚育|怀孕|生育|婚姻|年龄|[0-9]{2}\s*岁|民族|种族|宗教|残疾|残障|健康状况|病史|疾病|血型|身高|体重|家庭情况|星座|生肖|户籍|户口|国籍/;
export const professionalCriteria = values => (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim() && !sensitiveCriterion.test(value)).map(value => value.trim());
