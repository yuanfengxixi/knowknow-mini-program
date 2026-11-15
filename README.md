# KnowKnow Mini Program

知知是一个基于微信小程序和腾讯云开发（CloudBase）的个人知识库与 AI 思考伙伴示例。此仓库提供小程序界面和云函数源码，供开发者自行配置、部署和审查。

## 功能

- 记录、整理、搜索和导出 Markdown 笔记
- 通过云函数与 AI Agent 对话、查找和更新笔记
- 文件解析、知识库检索、会员额度与任务队列示例
- 微信小程序端的语音输入、附件和回收站界面

项目包含可配置的会员和虚拟支付代码。使用前请自行核对微信平台规则、支付资质、数据保护要求及当前代码中的默认业务参数。

## 开发环境

- 微信开发者工具与小程序 AppID
- 腾讯云开发（CloudBase）环境
- Node.js（云函数 package.json 中注明的依赖）
- 本仓库中配置所需的模型、嵌入、支付和 Web 登录凭据

## 本地配置

1. 将根目录 `project.config.json` 中的 `touristappid` 替换为你自己的小程序 AppID。
2. 在 `miniprogram/app.js` 的 `globalData.cloudEnv` 填入你自己的 CloudBase 环境 ID；留空时使用开发者工具选定的当前环境。
3. 在 CloudBase 控制台按云函数需要设置运行时环境变量。变量名称示例见 `.env.example`；不要把真实密钥写进 Git。
4. 将 Web 登录配置中的 `example.com` 替换成你自己已验证的回调域名，并配置对应的微信网站应用信息。
5. 检查 `miniprogram/pages/legal/content.js`、会员页和账号页的占位说明，为自己的服务补充经过审查的隐私政策、用户协议、会员规则、退款说明和客服信息。
6. 核对 `miniprogram/utils/constants.js`、会员页与云函数中的额度、价格、配额和模型默认值，再部署到自己的测试环境。
7. 在仓库根目录运行 `node scripts/sync-cloudfunction-shared.cjs`，将共享云函数模块复制到各函数目录；随后使用微信开发者工具打开仓库并部署 `miniprogram/cloudfunctions/` 下的云函数。
8. 确认云端集合、索引与访问规则符合你的隔离要求，再用 `cd tests && npm ci && npm test` 运行本地 Node 测试。

本仓库不提供可直接使用的 AppID、CloudBase 环境、模型密钥或支付凭据；也不代表这些能力已在你的账号或生产环境验证。

## CloudBase 云函数环境变量

`.env.example` 只列运行时变量名称，不含密钥值：`DEEPSEEK_API_KEY`、`EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`TASK_DISPATCH_SECRET`、`TASK_WORKER_NAME`、`WECHAT_WEB_APP_ID`、`WECHAT_WEB_APP_SECRET`、`ARK_API_KEY`、`ARK_IMAGE_MODEL`、`WECHAT_MINIPROGRAM_APP_SECRET`、`VIRTUAL_PAY_OFFER_ID`、`VIRTUAL_PAY_APP_KEY`、`VIRTUAL_PAY_GOODS_ID`。只为已启用的功能配置变量。CloudBase 会提供 `SCF_NAMESPACE`、`TCB_ENV`、`TENCENTCLOUD_REGION` 和临时云端凭据；部署用腾讯云 API 密钥不要放进函数环境变量。

## 许可

源码依据仓库根目录的 MIT License 发布。第三方依赖、微信插件及其商标仍受各自许可和平台条款约束。
