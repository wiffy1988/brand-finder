# 衣脉 · 品牌知识库 (brand-finder)

纯本地、中文 UI 的个人品牌知识库 PWA。适合在外贸市场淘冷门户外品牌时，把品牌故事、价位参考和成衣照片记在手机上。

**不调用任何 AI 或外部 API。** 所有品牌、淘货记录和照片只存在本机 IndexedDB。

## 功能

- **品牌库**：品牌名、国家/地区、创立年份、创始人/所有者、品牌故事、主打定位、有趣的事、价位参考、标签、可选封面图
- **淘货**：多张照片（拍照/相册）、关联品牌、日期、备注（哪里买的、尺码、成色、价格）
- **搜索**：按名称、国家、标签、故事全文筛选品牌与淘货
- **备份**：导出 / 导入 JSON（含照片 base64）
- **PWA**：可「添加到主屏幕」，离线可用（service worker 缓存静态资源）

内置一条可删除的示例品牌：**SOS · Sportswear of Sweden**。

## 文件

```
index.html  styles.css  app.js  sw.js  manifest.webmanifest  icons/
```

部署整个文件夹到任意静态 HTTPS 主机即可。发版时请 bump `sw.js` 里的 `VERSION`。

## 本地预览

```bash
cd brand-finder && python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/
```

IndexedDB / 相机在部分浏览器对 `file://` 限制较严，请用本地 HTTP 服务打开。

## 使用

1. iPhone Safari 打开站点 → 分享 → 添加到主屏幕
2. 在「品牌」页添加或编辑品牌；在「淘货」页给某件衣服挂照片
3. 「我的」里定期导出 JSON 备份
