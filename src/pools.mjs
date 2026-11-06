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
// 科室库：参照北京大学第一医院临床科室设置（www.pkufh.com），剔除医技与行政部门
export const DEPARTMENTS = [
  // 内科系统
  '呼吸和危重症医学科', '消化内科', '心血管内科', '内分泌内科', '血液内科', '肾脏内科',
  '老年病内科', '风湿免疫科', '感染疾病科', '神经内科', '皮肤性病科', '肿瘤内科',
  '全科医学科', '中医、中西医结合科',
  // 外科系统
  '胃肠外科', '肝胆胰外科', '甲状腺乳腺外科', '骨科', '心脏外科', '胸外科',
  '泌尿外科', '神经外科', '小儿外科', '介入血管外科', '整形烧伤外科',
  // 专科与其他
  '妇产生殖医学中心', '儿内科', '眼科', '耳鼻咽喉－头颈外科', '口腔科',
  '康复医学科', '疼痛科', '急诊科', '临床营养科',
];
export const DOCTOR_LANGUAGES = ['中文', '英语'];
export const DISEASE_EXAMPLES = ['肾结石', '早期膀胱癌', '甲型流感', '慢阻肺', '急性心梗', '脾阳虚', '慢性背痛'];

// 标准病人预设（SP 病例库）：一键填充患者参数面板，覆盖常见科室与文化情境
// 字段与前端 collectParams 一致；name 留空则按国籍随机取
export const PRESET_PATIENTS = [
  {
    label: '经典病例｜肾结石（美国·英文）',
    disease: '肾结石', country: '美国', language: '英文', gender: '女', age: 42, name: '',
    personality: '急躁', healthLiteracy: '较高（了解常见医学常识）', religion: '无特定信仰', diet: '无特殊要求',
    taboos: '', symptoms: '左侧腰部绞痛，阵发性,血尿,恶心', history: '两年前有过一次类似发作，自行多喝水缓解',
  },
  {
    label: '慢病管理｜2型糖尿病随访（日本·日文）',
    disease: '2型糖尿病', country: '日本', language: '日文', gender: '男', age: 58, name: '',
    personality: '谨慎多问', healthLiteracy: '一般', religion: '佛教', diet: '糖尿病饮食',
    taboos: '', symptoms: '多饮多尿,近期体重下降,容易疲劳', history: '糖尿病史5年，口服二甲双胍，血糖控制不佳',
  },
  {
    label: '慢病管理｜高血压复诊（法国·法语）',
    disease: '原发性高血压', country: '法国', language: '法语', gender: '男', age: 65, name: '',
    personality: '平和', healthLiteracy: '一般', religion: '天主教', diet: '低盐低脂',
    taboos: '忌讳直接谈论死亡', symptoms: '晨起头痛,血压偏高', history: '高血压10年，服用氨氯地平，近期漏服',
  },
  {
    label: '呼吸科｜哮喘急性发作（英国·英文）',
    disease: '支气管哮喘', country: '英国', language: '英文', gender: '女', age: 24, name: '',
    personality: '焦虑', healthLiteracy: '较高（了解常见医学常识）', religion: '无特定信仰', diet: '无特殊要求',
    taboos: '', symptoms: '喘息,夜间憋醒,胸闷咳嗽', history: '儿童期起病，对花粉和尘螨过敏',
  },
  {
    label: '文化情境｜清真饮食与斋月（马来西亚裔·英文）',
    disease: '慢性胃炎', country: '美国', language: '英文', gender: '男', age: 35, name: '',
    personality: '谨慎多问', healthLiteracy: '一般', religion: '伊斯兰教', diet: '清真饮食',
    taboos: '宗教祷告时间需要被尊重', symptoms: '上腹部隐痛,餐后胀气,反酸', history: '幽门螺杆菌感染史，服药不规律',
  },
  {
    label: '文化情境｜不接受异性触碰（韩国·韩文）',
    disease: '膝关节骨关节炎', country: '韩国', language: '韩文', gender: '女', age: 62, name: '',
    personality: '谨慎多问', healthLiteracy: '较低（需要通俗解释）', religion: '无特定信仰', diet: '无特殊要求',
    taboos: '不接受异性医护身体接触', symptoms: '双膝疼痛,上下楼加重,晨僵', history: '症状渐进两年余，未系统诊治',
  },
  {
    label: '行前咨询｜跨海续治（西班牙·西班牙语）',
    disease: '早期膀胱癌', country: '西班牙', language: '西班牙语', gender: '男', age: 55, name: '',
    personality: '开朗', healthLiteracy: '一般', religion: '天主教', diet: '无特殊要求',
    taboos: '', symptoms: '无痛性肉眼血尿,尿频', history: '已行TURBT手术，术后灌注治疗中，计划回国继续治疗',
  },
  {
    label: '中医科｜脾胃虚寒调理（新加坡裔·英文）',
    disease: '脾阳虚', country: '澳大利亚', language: '英文', gender: '女', age: 30, name: '',
    personality: '平和', healthLiteracy: '较低（需要通俗解释）', religion: '佛教', diet: '素食',
    taboos: '对动物来源药物有顾虑', symptoms: '畏寒怕冷,食欲差,大便稀溏,腹部喜温喜按', history: '长期饮食不规律，症状反复半年',
  },
];

export function findCountry(name) {
  return COUNTRIES.find(c => c.name === name) || COUNTRIES[0];
}
