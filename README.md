# 外贸 AI 询盘助手 MVP

一个面向外贸小团队的本地 Web 工具：把客户询盘转换成需求摘要、英文邮件草稿、报价草稿、风控判断和跟进记录。

## 配置 DeepSeek

复制 `.env.example` 为 `.env`，填入你的正式 Key：

```env
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-chat
PORT=8787
```

API Key 只在本地 Node 服务端读取，不会写进浏览器代码。

可选：配置通用 IMAP/SMTP 邮箱自动处理。请使用邮箱授权码或应用密码，不要使用网页登录密码：

```env
MAIL_IMAP_HOST=imap.example.com
MAIL_IMAP_PORT=993
MAIL_IMAP_SECURE=true
MAIL_IMAP_USER=sales@example.com
MAIL_IMAP_PASSWORD=your-mail-app-password

MAIL_SMTP_HOST=smtp.example.com
MAIL_SMTP_PORT=465
MAIL_SMTP_SECURE=true
MAIL_SMTP_USER=sales@example.com
MAIL_SMTP_PASSWORD=your-mail-app-password
MAIL_FROM="Sales Team <sales@example.com>"

MAIL_POLL_INTERVAL_SECONDS=60
MAIL_LOOKBACK_DAYS=3
```

## 启动

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5173
```

## 当前功能

- 录入公司资料和客户询盘
- 维护简易产品报价库
- 导入 `.xlsx` / `.xls` / `.csv` 产品表，自动映射产品名、SKU、价格、MOQ、交期、备注
- 调用 DeepSeek 提取客户需求
- 识别垃圾询盘、骚扰、诈骗、同行比价、低意向和有效客户
- 使用市场化多维评分：客户匹配、采购意图、成交准备、商业价值、风险安全和时效优先
- 每次分析自动保存到询盘历史库
- 支持按客户、国家、邮箱、产品或原始询盘搜索历史
- 支持按线索质量和跟进状态筛选历史
- 线索看板按新询盘、已自动回复、客户已回复、待跟进、人工核查、发送失败、已沉默分组，并支持一键筛选
- 点击历史记录可回看原始询盘、AI 分析和邮件草稿
- 支持通用 IMAP/SMTP 邮箱接入，可用单邮箱 `.env` 配置，也可用 `MAIL_ACCOUNTS_JSON` 接入多个邮箱统一收件
- 多邮箱模式下，线索会记录来源邮箱，自动回复和人工补发会使用收到该邮件的邮箱原路回复
- 低风险高分询盘可自动发送纯文本英文回复；人工核查类线索不会自动回复
- 首次回复后自动生成第 3 天/第 7 天跟进任务；客户回信后暂停后续自动跟进
- 邮件线程会按客户邮箱、公司名和项目主题归并；同客户同项目的后续邮件会追加到原线索时间线，而不是新建重复线索
- 客户后续回信会重新执行二次风控；出现付款链接、门户、银行登录、验证费等高危信号时自动标记为 `二次风险升级` 并暂停自动跟进
- 第 7 天跟进后仍未收到客户回信的线索会自动标记为已沉默，并生成一封人工接管建议邮件供复制
- 英文邮件草稿一键复制
- 生成报价草稿和跟进计划
- 报价单文本一键复制，支持下载 `quotation.txt`，并可导出 `.xlsx` 报价单

## 风控能力

系统会先做规则预检，再调用 DeepSeek 生成结构化分析，最后再做一次强制保护：

- 供应商验证费、激活费、认证费、付款门户、后续安全链接：强制判为 `scam`
- 点击链接索要密码、信用卡、银行登录或付款门户：强制判为 `scam`
- 要求付款到第三方公司、个人账户、Western Union 等非买方主体账户：强制判为 `scam`
- 免费邮箱冒充 REWE/Edeka/Aldi/Lidl 等知名买家或授权方：进入高风险人工核查
- 未知供应商平台注册、未知/不可核验货代：进入人工核查
- 官网维护、附件资料、可退款小额费用、指定买方货代：降低线索评分
- 邮箱域名与官网域名自动比较；同一邮件里有多个邮箱时，只要有一个公司邮箱与官网匹配，就不误扣
- RDAP 查询域名年龄；只有查到域名注册不足 90 天才扣分，查不到不扣分
- 自动提取 EU VAT ID，并通过欧盟 VIES 接口校验有效性；无效或公司名明显不匹配会进入人工核查
- 提供 HRB、VAT、公司域名邮箱、详细规格、标准付款条款、完整签名会按正向信号加分
- 评分模型会把 Fit、Intent、Readiness、Commercial Value 和 Risk Safety 分开计算，再合成为 A1/A2/B/C/D 线索层级
- 首单/无历史交易、自报 HRB/VAT、域名年龄未检查不再作为扣分项
- FOB Hamburg 这类贸易术语不一致会提示澄清，但不会直接判诈骗
- 诈骗或人工核查模式不会输出详细报价
- 邮箱自动回复只允许 `qualified`、评分不低于 85、回复模式为 `full_quote` 或 `ask_more` 且无核验任务的线索通过

## 邮箱自动处理

在 `.env` 配置 `MAIL_IMAP_*` 和 `MAIL_SMTP_*` 后，页面顶部会显示“邮箱自动处理”工作台：

- “测试连接”只验证 IMAP/SMTP 登录，不发送客户邮件
- “立即同步一次”会拉取 INBOX 最近几天邮件，提取邮件头和正文，调用同一套 DeepSeek + 风控分析
- 系统用邮件 `Message-ID` 去重，同一封邮件不会重复入库或重复自动回复
- 自动回复只发送纯文本英文草稿，不带附件，不发送银行信息，不点击或提交任何客户链接
- 后端启动后会自动同步一次，并按 `MAIL_POLL_INTERVAL_SECONDS` 定时轮询；最近一次产品库和公司资料会作为邮箱分析上下文
- 已自动回复的有效线索会自动安排 3 天和 7 天跟进；如果客户在跟进前回信，后续 pending 跟进会暂停
- 客户回信会被记录到同一条线索的“对话时间线”，并把状态切换为 `客户已回复`

## 身份核验清单

风控面板会根据询盘内容生成下一步核验任务：

- 域名：RDAP/WHOIS 查询域名年龄，核对邮箱域名与官网域名
- 商业登记：核对 HRB、法院、公司名与公开登记信息
- VAT：通过 EU VIES 校验 VAT ID 是否有效且匹配公司
- 电话：人工回拨官网公开电话，不使用邮件内临时号码
- 银行账户：要求公司域名邮箱发送账户证明，首单坚持安全付款条款
- 授权声明：对 REWE/Edeka 等零售商授权或大订单，要求授权书或 PO 参考

## 验证

```bash
npm run test:risk
npm run test:mail
npm run build
```

`test:risk` 包含诈骗验证费、中小企业误判、正常 RFQ、域名匹配、RDAP 年龄、VAT 无效/不匹配等回归测试。`test:mail` 覆盖邮箱自动回复安全门槛。

## 产品表导入

在“产品报价库”点击“导入表格”，选择 `.xlsx`、`.xls` 或 `.csv` 文件。系统会识别这些常见表头：

- 产品名：`name`、`product`、`产品`、`产品名`、`品名`
- SKU：`sku`、`model`、`item no`、`型号`、`货号`
- 价格：`price`、`unit price`、`FOB price`、`报价`、`价格`
- MOQ：`moq`、`minimum order quantity`、`起订量`
- 交期：`lead time`、`delivery time`、`交期`
- 备注：`notes`、`description`、`specification`、`备注`、`规格`

导入后会替换当前产品库，并立即用于下一次询盘分析。
