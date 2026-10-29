// 参数池：患者随机生成与下拉选项（前端 /api/config 与后端兜底随机共用）
export const COUNTRIES = [
  {name: '美国', language: '英文', names: {female: ['Emily Clark', 'Sarah Jones', 'Olivia Martin'], male: ['John Smith', 'Michael Brown', 'David Wilson']}},
  {name: '英国', language: '英文', names: {female: ['Emma Wallace', 'Alice Brown'], male: ['James Anderson', 'Daniel Thomas']}},
  {name: '澳大利亚', language: '英文', names: {female: ['Sophia Moore', 'Grace Miller'], male: ['Jack Wilson', 'Liam Walker']}},
  {name: '加拿大', language: '英文', names: {female: ['Laura Taylor', 'Chloe Adams'], male: ['Ryan Carter', 'Noah Scott']}},
  {name: '日本', language: '日文', names: {female: ['佐藤美咲', '田中花子'], male: ['田中太郎', '佐藤健一']}},
  {name: '法国', language: '法语', names: {female: ['Marie Dupont', 'Claire Martin'], male: ['Louis Bernard', 'Lucas Petit']}},
  {name: '西班牙', language: '西班牙语', names: {female: ['María García', 'Lucía Fernández'], male: ['Carlos López', 'Javier Martínez']}},
  {name: '韩国', language: '韩文', names: {female: ['金智秀', '李知恩'], male: ['金敏俊', '李承浩']}},
];

export const LANGUAGES = ['英文', '日文', '法语', '西班牙语', '韩文'];
export const RELIGIONS = ['无特定信仰', '基督教', '天主教', '伊斯兰教', '佛教', '印度教', '犹太教'];
export const DIETS = ['无特殊要求', '素食', '清真饮食', '低盐低脂', '无麸质饮食', '糖尿病饮食'];
export const TABOOS = ['无特殊禁忌', '忌讳直接谈论死亡', '不接受异性医护身体接触', '对动物来源药物有顾虑', '宗教祷告时间需要被尊重'];
export const PERSONALITIES = ['焦虑', '急躁', '平和', '谨慎多问', '开朗'];
export const LITERACIES = ['较高（了解常见医学常识）', '一般', '较低（需要通俗解释）'];
export const GENDERS = ['女', '男'];
export const DEPARTMENTS = ['泌尿外科', '呼吸内科', '心血管内科', '中医科', '消化内科', '内分泌科', '骨科'];
export const DOCTOR_LANGUAGES = ['中文', '英语'];
export const DISEASE_EXAMPLES = ['肾结石', '早期膀胱癌', '甲型流感', '慢阻肺', '急性心梗', '脾阳虚', '慢性背痛'];

export function findCountry(name) {
  return COUNTRIES.find(c => c.name === name) || COUNTRIES[0];
}
