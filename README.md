# A 股自选股监控面板

这是一个 Node.js 网页版自选股监控工具，启动后在浏览器里查看自选股行情、分时强弱、均线、昨日状态和买点/预警规则。

## 本地启动

需要 Node.js 18 或以上版本。

```powershell
npm start
```

打开：

```text
http://127.0.0.1:8787/
```

也可以直接双击 `start_dashboard.bat` 启动。

## 配置

项目内带有默认配置文件：

- `watchlist.json`：自选股列表和刷新间隔
- `buy_signals.json`：买点/预警规则

网页顶部的“自选股管理”可以直接新增股票、修改名称/备注、调整刷新秒数、删除股票。修改会写回 `watchlist.json`。

如果部署到云端，网页修改的是云端运行环境里的 `watchlist.json`。多数免费平台重启或重新部署后会恢复到 GitHub 仓库里的版本，所以长期保存仍建议把确认后的 `watchlist.json` 提交回 GitHub。

## 云端部署

这个项目需要 Node.js 服务端转发行情数据，不适合直接用 GitHub Pages 作为纯静态网页部署。

部署到 Render、Railway、Fly.io、VPS 等 Node.js 环境时：

- 启动命令：`npm start`
- 环境变量：`HOST=0.0.0.0`
- 端口：使用平台提供的 `PORT`，代码会自动读取

## Cloudflare Workers

仓库里已经带了 Cloudflare Worker 版本入口 [cloudflare-worker.mjs](/D:/Cline/kline-web/cloudflare-worker.mjs:1) 和 [wrangler.jsonc](/D:/Cline/kline-web/wrangler.jsonc:1)。

Cloudflare 版本和本地 Node 版本的区别：

- 本地版把配置写到 `watchlist.json`
- Cloudflare 版把配置写到 KV 里的 `APP_CONFIG`
- 首次部署时，如果 KV 还没有数据，会用仓库当前的自选股和规则初始化

部署步骤：

```powershell
npm install
npm run cf:check
npm run cf:deploy
```

部署后网页里继续可以直接修改自选股、备注和刷新秒数，但这些修改保存在 Cloudflare KV，不会自动回写到 GitHub 仓库。

## 数据源

行情数据来自新浪行情接口。接口可用性、频率限制和数据延迟取决于第三方服务。
