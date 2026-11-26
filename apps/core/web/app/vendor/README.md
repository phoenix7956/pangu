# vendor/ —— 本地第三方文件 (不引 CDN, 不联网)

这个目录是工作台**唯一**允许放第三方成品文件的地方。规矩跟别处一样：
站内地址一律相对、零外链、零 webfont、零 CDN 引用。放进这个目录的文件
由**仓库自己**伺服 (`/vendor/xxx` ⇒ `web/app/vendor/xxx`)，跟着盘古一起跑。

## 为什么要有这个目录

盘古的浏览器工作台一直是"手写 HTML + CSS + ESM，零构建、零 npm 依赖、零外部资源"。
画折线图这件事手写当然也能干（几十行 SVG），但要画的东西一多（双轴、悬浮提示、
缩放、图例），自己维护一套画图引擎就是给自己找活干。

所以这里放一个**离线**的图表库：MIT 协议，可商用，随仓库分发，不需要账号、
不需要联网、不收钱。

## 当前内容

| 文件 | 是什么 | 协议 | 体积 |
|---|---|---|---|
| `plotly-basic.min.js` | plotly.js v2.35.2 的 **basic** 分包（折线/柱/饼/面积等基础图形） | MIT | 1.0 MB |
| `plotly-basic.min.js.LICENSE.txt` | 该分包内含的第三方代码的许可声明（plotly.js 官方随包发布） | — | 305 B |
| `plotly-LICENSE.txt` | plotly.js 主许可（MIT 全文） | MIT | 1.1 KB |

### 为什么是 basic 分包而不是完整包

完整包 `plotly.min.js` 是 4.5 MB（带 mapbox / gl3d / 金融图 / 地理图）。
basic 分包 1.0 MB，包含了「进化」这一页实际用到的全部图形类型
（`scatter` / `bar` / `pie` / `area`）。少 3.5 MB，比多背一个地图库划算。

### 为什么不用 CDN

1. **数据外流**：CDN 版本会把请求发到 plotly 的 CDN（哪怕不发数据，也多一个
   第三方依赖面）；
2. **断网即废**：盘古是本机软件，可能在完全离线的环境里跑；
3. **供应链**：仓库自己伺服的那一份，版本和哈希都是自己定的。

### 怎么升级

```bash
# 取官方 basic 分包（版本号自己定，别用 latest —— 版本要钉死）
curl -o apps/core/web/app/vendor/plotly-basic.min.js \
  https://cdn.plot.ly/plotly-basic-<版本>.min.js
curl -o apps/core/web/app/vendor/plotly-basic.min.js.LICENSE.txt \
  https://unpkg.com/plotly.js@<版本>/dist/plotly-basic.min.js.LICENSE.txt
curl -o apps/core/web/app/vendor/plotly-LICENSE.txt \
  https://unpkg.com/plotly.js@<版本>/LICENSE
```

升级完把 `NOTICE` 里的版本号改掉，并在 `tests/evolution-view-plotly-20261125.test.js`
里更新版本断言。

## 怎么用

**不要**在 `index.html` 里写 `<script src="vendor/plotly-basic.min.js">` ——
那会让每个页面都背 1 MB，而这 1 MB 只有「进化」一页用得上。
正确做法是那一页**按需加载**（见 `views/evolution.mjs` 里的 `loadPlotly()`）：
首次进页面时插一个 `<script>`，加载完再画图，页面之间来回切不会重复下载。

