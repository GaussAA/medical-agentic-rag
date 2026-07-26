/**
 * 黄金数据集第一批生成器 —— 20 道高难度/陷阱/弱势科室题
 *
 * 用法: node tests/scripts/generate-gold-items.mjs
 * 效果: 追加 20 道新题到 gold-answers.json（ID 从 Q66 起编）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));

const newItems = [
  // ── 弱势科室补强：儿科（现有仅 Q02 1题）──
  {
    id: "Q66", department: "儿科", difficulty: "高",
    q: "儿童急性淋巴细胞白血病诱导缓解治疗的核心方案及注意事项",
    gtSources: ["儿童急性淋巴细胞白血病诊疗规范"],
    evidencePhrases: ["急性淋巴细胞白血病", "诱导缓解", "VP方案", "门冬酰胺酶", "肿瘤溶解综合征"],
    expectGradeLabel: false,
    referenceAnswer: "儿童ALL诱导缓解治疗以长春新碱+糖皮质激素（泼尼松/地塞米松）为基础，联合门冬酰胺酶和蒽环类药物。注意事项：充分水化碱化预防肿瘤溶解综合征，监测血尿酸和电解质；预防性使用复方磺胺甲噁唑防卡氏肺孢子菌肺炎；及时处理糖皮质激素引起的高血糖和高血压。",
    allowedClaims: ["长春新碱", "门冬酰胺酶", "肿瘤溶解综合征"],
    forbiddenClaims: ["儿童ALL与成人ALL化疗方案完全一致", "诱导缓解不需预防感染"],
    expectedRefusal: false
  },
  {
    id: "Q67", department: "儿科", difficulty: "陷阱",
    q: "8个月婴儿发热39.5°C伴惊厥，能否使用阿司匹林退热",
    gtSources: ["儿童发热与惊厥处理专家共识"],
    evidencePhrases: ["婴儿", "发热", "惊厥", "阿司匹林", "Reye综合征"],
    expectGradeLabel: false,
    referenceAnswer: "不能。婴幼儿病毒感染时使用阿司匹林有诱发Reye综合征的风险，应避免使用。推荐对乙酰氨基酚（10-15mg/kg/次）或布洛芬（5-10mg/kg/次）退热。惊厥发作时保持呼吸道通畅，多数热性惊厥在3-5分钟内自行停止，持续超过5分钟需就医。",
    allowedClaims: ["Reye综合征", "对乙酰氨基酚", "热性惊厥"],
    forbiddenClaims: ["婴儿发热可以用阿司匹林退热", "热性惊厥持续30分钟才需就医"],
    expectedRefusal: false
  },
  // ── 弱势科室补强：急诊（现有仅 Q33 2题）──
  {
    id: "Q68", department: "急诊", difficulty: "高",
    q: "急性ST段抬高型心肌梗死的急诊再灌注治疗选择与时间窗",
    gtSources: ["中国ST段抬高型心肌梗死诊断和治疗指南"],
    evidencePhrases: ["ST段抬高型心肌梗死", "急诊PCI", "静脉溶栓", "时间窗", "门球时间"],
    expectGradeLabel: true,
    referenceAnswer: "STEMI急诊再灌注首选直接PCI，要求门-球时间<90分钟。若首次医疗接触至PCI延迟>120分钟，或无法在120分钟内转运至PCI中心，则优先静脉溶栓（发病<3小时效果最佳，最迟<12小时）。溶栓后3-24小时常规行冠状动脉造影。抗血小板治疗：双抗（阿司匹林+P2Y12受体抑制剂），抗凝首选普通肝素或低分子肝素。",
    allowedClaims: ["直接PCI", "门-球时间<90分钟", "静脉溶栓", "双抗"],
    forbiddenClaims: ["所有STEMI患者均应首选溶栓", "门-球时间无严格要求"],
    expectedRefusal: false
  },
  {
    id: "Q69", department: "急诊", difficulty: "陷阱",
    q: "一个中年男性被发现意识丧失、呼吸停止，路人开始心肺复苏。按压深度和频率应该是多少？AED到来后如何使用？",
    gtSources: ["中国心肺复苏专家共识"],
    evidencePhrases: ["心肺复苏", "胸外按压", "AED", "按压深度", "按压频率"],
    expectGradeLabel: false,
    referenceAnswer: "成人胸外按压深度5-6cm，频率100-120次/分，按压与通气比30:2。AED到达后立即开机，按语音提示操作：贴电极片（右上胸、左下胸），分析心律时无人接触患者，若建议电击则确保无人接触后按下电击按钮，之后立即恢复按压。",
    allowedClaims: ["5-6cm", "100-120次/分", "30:2", "AED"],
    forbiddenClaims: ["按压深度至少8cm", "AED分析心律时可以接触患者"],
    expectedRefusal: false
  },
  // ── 高难度：跨指南冲突/剂量换算 ──
  {
    id: "Q70", department: "心血管", difficulty: "高",
    q: "一位合并慢性肾脏病3期（eGFR 38ml/min）的房颤患者，如何选择抗凝方案？DOAC剂量如何调整？",
    gtSources: ["中国心房颤动诊断和治疗指南", "中国慢性肾脏病诊治指南"],
    evidencePhrases: ["房颤", "CKD", "eGFR", "DOAC", "剂量调整", "NOAC"],
    expectGradeLabel: true,
    referenceAnswer: "合并CKD3期的房颤患者，除有禁忌外推荐DOAC优于华法林。剂量调整：eGFR 30-49ml/min时，达比加群酯110mg bid（禁用150mg），利伐沙班15mg qd（不推荐20mg），阿哌沙班5mg bid（满足2项标准降为2.5mg bid：年龄≥80岁、体重≤60kg、Scr≥1.5mg/dL），艾多沙班30mg qd。需每6-12个月复查肾功能，eGFR<30时禁用达比加群酯和利伐沙班。",
    allowedClaims: ["eGFR 30-49", "达比加群酯110mg", "利伐沙班15mg", "DOAC"],
    forbiddenClaims: ["CKD患者一律用华法林", "CKD患者DOAC无需调剂量"],
    expectedRefusal: false
  },
  // ── 陷阱题：药物相互作用 ──
  {
    id: "Q71", department: "药事", difficulty: "陷阱",
    q: "患者在服用他汀类降脂药期间，医生新开了克拉霉素治疗呼吸道感染。需要注意什么？",
    gtSources: ["中国血脂管理指南"],
    evidencePhrases: ["他汀", "克拉霉素", "CYP3A4", "横纹肌溶解", "药物相互作用"],
    expectGradeLabel: true,
    referenceAnswer: "克拉霉素是强CYP3A4抑制剂，可显著升高他汀类药物血药浓度，增加横纹肌溶解风险。处理：治疗期间应暂停他汀，或换用非CYP3A4代谢的他汀（如普伐他汀、瑞舒伐他汀）并减量。同时监测肌痛、肌无力症状及肌酸激酶水平。",
    allowedClaims: ["CYP3A4", "横纹肌溶解", "暂停他汀", "瑞舒伐他汀"],
    forbiddenClaims: ["克拉霉素和他汀可以安全联用", "无需调整剂量"],
    expectedRefusal: false
  },
  // ── 陷阱题：特殊人群用药 ──
  {
    id: "Q72", department: "妇产", difficulty: "高",
    q: "妊娠期高血压患者，血压160/105mmHg，应选择哪些降压药物？哪些药物是禁忌？",
    gtSources: ["妊娠期高血压疾病诊治指南（2020）"],
    evidencePhrases: ["妊娠期高血压", "降压", "拉贝洛尔", "硝苯地平", "ACEI禁忌"],
    expectGradeLabel: true,
    referenceAnswer: "妊娠期高血压（≥160/110mmHg）需启动降压治疗。首选拉贝洛尔、硝苯地平或甲基多巴。静脉用药可选拉贝洛尔或乌拉地尔。禁忌：ACEI（卡托普利、依那普利等）、ARB（氯沙坦、缬沙坦等）在妊娠期禁用——有胎儿肾发育异常和羊水过少风险。阿替洛尔也避免使用（胎儿生长受限风险）。",
    allowedClaims: ["拉贝洛尔", "硝苯地平", "甲基多巴", "ACEI禁忌"],
    forbiddenClaims: ["妊娠期高血压首选卡托普利", "ACEI在妊娠期是安全的"],
    expectedRefusal: false
  },
  // ── 高难度：罕见并发症 ──
  {
    id: "Q73", department: "血液", difficulty: "高",
    q: "使用利妥昔单抗治疗过程中，患者出现严重输液反应的处理流程",
    gtSources: ["利妥昔单抗临床应用专家共识"],
    evidencePhrases: ["利妥昔单抗", "输液反应", "细胞因子释放综合征", "预处理", "减慢滴速"],
    expectGradeLabel: true,
    referenceAnswer: "利妥昔单抗输液反应处理：轻度（发热寒战）→减慢滴速+抗组胺药；中度（呼吸困难、低血压）→暂停输注+糖皮质激素+支气管舒张剂+补液；重度（严重CRS、支气管痉挛）→立即停用+肾上腺素+高流量氧疗+必要时收入ICU。预防：首次输注前给予对乙酰氨基酚+抗组胺药，以50mg/h起始缓慢滴注，严密监测生命体征。",
    allowedClaims: ["减慢滴速", "糖皮质激素", "肾上腺素", "预处理"],
    forbiddenClaims: ["输液反应可继续原速输注", "重度反应仅需解热镇痛药"],
    expectedRefusal: false
  },
  // ── 弱势科室补强：外科综合 ──
  {
    id: "Q74", department: "外科综合", difficulty: "中",
    q: "急性阑尾炎的典型临床表现和诊断要点",
    gtSources: ["急性阑尾炎诊疗指南"],
    evidencePhrases: ["转移性右下腹痛", "McBurney点压痛", "反跳痛", "白细胞升高", "腹部CT"],
    expectGradeLabel: false,
    referenceAnswer: "典型表现为转移性右下腹痛（起始于上腹/脐周，6-8小时后转移至右下腹），伴恶心呕吐、低热。体征：McBurney点固定压痛、反跳痛、腹肌紧张。实验室：白细胞及中性粒细胞升高。影像学：腹部CT是首选确诊手段，可见阑尾增粗（>6mm）、管壁增厚、周围脂肪间隙模糊。",
    allowedClaims: ["转移性右下腹痛", "McBurney点", "CT"],
    forbiddenClaims: ["阑尾炎不会出现反跳痛", "诊断阑尾炎不需要影像学检查"],
    expectedRefusal: false
  },
  // ── 高难度：感染合并症 ──
  {
    id: "Q75", department: "感染", difficulty: "陷阱",
    q: "HIV感染者发现CD4计数降至180/μL且病毒载量升高，是否需要调整抗病毒方案？考虑哪些因素？",
    gtSources: ["中国艾滋病诊疗指南（2024版）"],
    evidencePhrases: ["HIV", "CD4", "病毒载量", "ART", "耐药检测", "方案调整"],
    expectGradeLabel: false,
    referenceAnswer: "CD4<200/μL提示免疫功能严重受损，病毒载量升高提示当前ART方案可能失败。处理：立即行HIV耐药基因型检测；根据耐药结果调整方案，至少更换2个有活性的药物（包括1个新机制药物）；加用复方磺胺甲噁唑预防肺孢子菌肺炎；评估有无机会性感染。不可在耐药结果出来前盲目加用单药。",
    allowedClaims: ["耐药检测", "更换2个药物", "复方磺胺甲噁唑", "PCP预防"],
    forbiddenClaims: ["CD4低直接加用新药即可", "不需耐药检测即可换方案"],
    expectedRefusal: false
  },
  // ── 高难度：多学科 ──
  {
    id: "Q76", department: "肿瘤", difficulty: "高",
    q: "III期非小细胞肺癌不可手术患者的标准治疗模式是什么？免疫治疗在其中的角色？",
    gtSources: ["中华医学会肺癌临床诊疗指南（2024版）"],
    evidencePhrases: ["III期NSCLC", "同步放化疗", "度伐利尤单抗", "PACIFIC方案", "维持治疗"],
    expectGradeLabel: true,
    referenceAnswer: "III期不可切除NSCLC标准治疗为同步放化疗，之后序贯度伐利尤单抗维持治疗（PACIFIC方案）。同步放化疗后未进展的患者，于放化疗后1-42天内启动度伐利尤单抗维持治疗12个月。PD-L1表达无需作为筛选条件（PACIFIC研究显示全人群获益）。禁忌：活动性自身免疫性疾病、间质性肺病。",
    allowedClaims: ["同步放化疗", "度伐利尤单抗", "PACIFIC", "维持12个月"],
    forbiddenClaims: ["III期不可切除首选手术", "免疫治疗仅用于PD-L1阳性患者"],
    expectedRefusal: false
  },
  // ── 陷阱题：紧急鉴别 ──
  {
    id: "Q77", department: "急诊", difficulty: "陷阱",
    q: "患者突发左侧胸痛伴呼吸困难，心电图正常。除了急性心肌梗死还应注意鉴别哪些急症？",
    gtSources: ["急性胸痛急诊诊疗专家共识"],
    evidencePhrases: ["胸痛", "鉴别诊断", "肺栓塞", "主动脉夹层", "气胸", "D-二聚体"],
    expectGradeLabel: false,
    referenceAnswer: "急性胸痛除ACS外需紧急鉴别：①急性肺栓塞——呼吸困难与胸痛不匹配，D-二聚体升高，CTPA确诊；②主动脉夹层——撕裂样胸痛放射至后背，血压不对称，CTA确诊；③自发性气胸——患侧呼吸音消失，X线确诊；④心包炎——前倾位缓解，广泛ST段抬高。上述任一急症均需紧急处理，不可因心电图正常排除。",
    allowedClaims: ["肺栓塞", "主动脉夹层", "气胸", "CTPA"],
    forbiddenClaims: ["心电图正常即可排除所有急症", "胸痛首先考虑肌肉骨骼来源"],
    expectedRefusal: false
  },
  // ── 弱势科室补强：眼科 ──
  {
    id: "Q78", department: "眼科", difficulty: "中",
    q: "糖尿病视网膜病变的筛查频率和治疗原则",
    gtSources: ["中国2型糖尿病防治指南", "糖尿病视网膜病变诊疗指南"],
    evidencePhrases: ["糖尿病视网膜病变", "筛查", "眼底检查", "激光光凝", "抗VEGF"],
    expectGradeLabel: true,
    referenceAnswer: "筛查频率：1型糖尿病发病后5年开始每年1次眼底检查；2型糖尿病确诊即查，之后每年1次。已发生DR者根据严重程度增加频率。治疗原则：轻度NPDR控制危险因素（血糖、血压、血脂）；重度NPDR和PDR行全视网膜激光光凝；累及黄斑的DME首选抗VEGF玻璃体腔内注射（雷珠单抗/康柏西普/阿柏西普）。",
    allowedClaims: ["每年1次眼底检查", "全视网膜激光光凝", "抗VEGF"],
    forbiddenClaims: ["DR不需定期筛查", "糖尿病确诊10年后再查眼底"],
    expectedRefusal: false
  },
  // ── 高难度：慢病综合管理 ──
  {
    id: "Q79", department: "慢病/代谢", difficulty: "高",
    q: "痛风急性发作时降尿酸药物应该怎么用？是否要停用已经正在服用的降尿酸药？",
    gtSources: ["中国高尿酸血症与痛风诊疗指南"],
    evidencePhrases: ["痛风急性发作", "秋水仙碱", "NSAIDs", "糖皮质激素", "降尿酸治疗时机"],
    expectGradeLabel: true,
    referenceAnswer: "痛风急性发作期：①首选NSAIDs（依托考昔/塞来昔布）或秋水仙碱（首剂1.2mg，1小时后0.6mg），无效可短期激素。②已服用降尿酸药（别嘌醇/非布司他/苯溴马隆）者不应停药——突然停药反而引起血尿酸波动加重发作。③未开始降尿酸者应在急性期控制2周后、关节症状完全缓解再启动降尿酸治疗。④急性期同时降尿酸需预防性使用秋水仙碱或NSAIDs至少3-6个月。",
    allowedClaims: ["不应停用降尿酸药", "秋水仙碱", "NSAIDs", "急性期后2周启动"],
    forbiddenClaims: ["急性发作期应停用降尿酸药", "发作期即可启动降尿酸"],
    expectedRefusal: false
  },
  // ── 陷阱题：儿童用药 ──
  {
    id: "Q80", department: "儿科", difficulty: "高",
    q: "早产儿出生后需要常规补充哪些营养素？剂量和持续时间是多少？",
    gtSources: ["早产儿营养管理专家共识"],
    evidencePhrases: ["早产儿", "维生素D", "铁剂", "钙磷", "母乳强化剂"],
    expectGradeLabel: false,
    referenceAnswer: "早产儿常规补充：①维生素D——出生后1周开始400-800IU/天，至少至1岁；②铁剂——出生后2-4周开始2-4mg/kg/天，矫正胎龄1-2岁；③钙磷——母乳喂养的极低体重儿需额外补充。此外，母乳喂养的极低体重儿（<1500g）需添加母乳强化剂至矫正胎龄40周或体重达标。",
    allowedClaims: ["维生素D 400-800IU", "铁剂2-4mg/kg", "母乳强化剂"],
    forbiddenClaims: ["早产儿不需常规补充维生素D", "铁剂出生即开始补充"],
    expectedRefusal: false
  },
  // ── 高难度：肿瘤急诊 ──
  {
    id: "Q81", department: "肿瘤", difficulty: "高",
    q: "肿瘤患者出现高钙血症（血钙3.5mmol/L）应如何紧急处理？",
    gtSources: ["肿瘤相关性高钙血症诊疗指南"],
    evidencePhrases: ["高钙血症", "双膦酸盐", "地舒单抗", "水化", "降钙素"],
    expectGradeLabel: true,
    referenceAnswer: "肿瘤高钙危象（>3.5mmol/L）紧急处理：①积极水化——生理盐水200-300ml/h（注意心肾功能），同时呋塞米促进尿钙排泄；②双膦酸盐——唑来膦酸4mg iv（首选）；③地舒单抗——双膦酸盐无效或肾功能不全时使用；④降钙素——快速降钙（数小时内），但数天后耐药；⑤糖皮质激素——血液系统肿瘤（多发性骨髓瘤、淋巴瘤）有效。同时处理原发肿瘤，监测心电和水电解质平衡。",
    allowedClaims: ["水化", "唑来膦酸", "地舒单抗", "降钙素"],
    forbiddenClaims: ["高钙血症只需口服补液", "双膦酸盐对高钙血症无效"],
    expectedRefusal: false
  },
  // ── 弱势科室补强：外科综合 ──
  {
    id: "Q82", department: "外科综合", difficulty: "中",
    q: "胆囊结石患者手术治疗的指征和术式选择",
    gtSources: ["胆囊良性疾病外科诊疗专家共识"],
    evidencePhrases: ["胆囊结石", "腹腔镜胆囊切除术", "有症状", "胆囊炎", "保胆取石"],
    expectGradeLabel: false,
    referenceAnswer: "手术指征：有症状的胆囊结石（胆绞痛、急性胆囊炎）、结石直径>3cm、胆囊壁钙化（瓷化胆囊）、合并胆囊息肉>1cm、糖尿病或免疫抑制患者无症状结石。标准术式为腹腔镜胆囊切除术（LC），LC禁忌或困难时开腹胆囊切除术。保胆取石手术不作为常规推荐（复发率高）。",
    allowedClaims: ["腹腔镜胆囊切除术", "有症状", "结石>3cm"],
    forbiddenClaims: ["所有无症状胆结石均需手术", "保胆取石是首选术式"],
    expectedRefusal: false
  },
  // ── 高难度：药物警戒 ──
  {
    id: "Q83", department: "心血管", difficulty: "高",
    q: "地高辛中毒的临床表现及处理原则",
    gtSources: ["中国心力衰竭诊断和治疗指南"],
    evidencePhrases: ["地高辛", "洋地黄中毒", "心律失常", "低钾", "地高辛特异性抗体片段"],
    expectGradeLabel: true,
    referenceAnswer: "地高辛中毒表现：①胃肠道——恶心呕吐、厌食；②神经——视物模糊、黄视绿视、定向障碍；③心脏——各种心律失常（室早二联律、房速伴阻滞、非阵发性交界性心动过速）。处理：①立即停药；②纠正低钾低镁；③危及生命的中毒静脉给予地高辛特异性抗体片段（Fab片段）；④缓慢心律失常可阿托品；⑤禁用电复律（室颤风险）。血清地高辛浓度>2.0ng/mL支持诊断。",
    allowedClaims: ["地高辛特异性抗体片段", "黄视绿视", "室早二联律", "停药"],
    forbiddenClaims: ["地高辛中毒常规使用利多卡因治疗", "轻度中毒不需停药"],
    expectedRefusal: false
  },
  // ── 弱势科室补强：骨代谢 ──
  {
    id: "Q84", department: "骨代谢", difficulty: "中",
    q: "骨质疏松症患者在双膦酸盐治疗期间需要监测哪些指标？治疗疗程多久？",
    gtSources: ["原发性骨质疏松症诊疗指南"],
    evidencePhrases: ["骨质疏松", "双膦酸盐", "BMD", "骨转换标志物", "药物假期"],
    expectGradeLabel: true,
    referenceAnswer: "双膦酸盐治疗期间监测：①每1-2年复查骨密度（BMD）；②每年监测骨转换标志物（BTMs，如P1NP、CTX-1）评估疗效；③肾功能（尤其唑来膦酸，需eGFR>35）；④血钙和维生素D水平（治疗前必须纠正维生素D缺乏）。疗程：口服双膦酸盐5年、静脉3-6年后重新评估低骨折风险者进入药物假期（1-3年），高骨折风险者继续治疗。",
    allowedClaims: ["BMD", "骨转换标志物", "药物假期", "口服5年"],
    forbiddenClaims: ["双膦酸盐可无限期使用不需停药", "治疗期间不需监测肾功能"],
    expectedRefusal: false
  },
  // ── 陷阱题：跨科室 ──
  {
    id: "Q85", department: "其他内科", difficulty: "陷阱",
    q: "一位65岁糖尿病患者因社区获得性肺炎住院，万古霉素治疗5天无效，痰培养提示MRSA（MIC=2μg/mL），应如何调整方案？",
    gtSources: ["中国MRSA感染防治专家共识", "抗菌药物临床应用指导原则"],
    evidencePhrases: ["MRSA", "万古霉素", "MIC", "达托霉素", "利奈唑胺", "替加环素"],
    expectGradeLabel: true,
    referenceAnswer: "万古霉素治疗MRSA肺炎5天无效且MIC=2μg/mL（已达到中介水平），提示万古霉素疗效可能不佳。应换用替代药物。对于MRSA肺炎，首选利奈唑胺600mg q12h（肺组织浓度高，优于万古霉素）。达托霉素不能在肺部感染中使用（被肺泡表面活性物质灭活）。替加环素虽对MRSA有效但组织浓度有限，不作为肺炎首选。同时需复查影像学和药敏，评估有无肺脓肿或脓胸等并发症。",
    allowedClaims: ["利奈唑胺", "达托霉素不能在肺部使用", "万古霉素MIC≥2"],
    forbiddenClaims: ["达托霉素可用于MRSA肺炎", "万古霉素MIC 2仍可继续使用"],
    expectedRefusal: false
  },
];

// ── 去重（防止断点续跑时重复） ──
const existingIds = new Set(gold.items.map((i) => i.id));
const toAdd = newItems.filter((i) => !existingIds.has(i.id));
gold.items.push(...toAdd);
gold.note = gold.note.replace(/(\d+) 题/, (_, n) => `${Number(n) + toAdd.length} 题`);

writeFileSync(GOLD_PATH, JSON.stringify(gold, null, 2), "utf-8");
console.log(`已追加 ${toAdd.length} 条黄金测试题（${toAdd.map((i) => i.id).join(", ")}）`);
console.log(`gold-answers.json 现共 ${gold.items.length} 题`);
console.log(`科室覆盖: ${[...new Set(gold.items.map((i) => i.department))].sort().join(", ")}`);
