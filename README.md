# 衣脉 · 品牌知识库 (brand-finder)

中文 UI 的个人品牌知识库 PWA。品牌故事、价位参考和成衣照片同步到 **Supabase** 云端（不调用 AI）。

## 功能

- **品牌库**：品牌名、国家/地区、创立年份、创始人/所有者、品牌故事、主打定位、有趣的事、价位参考、标签、可选封面图
- **淘货**：多张照片（拍照/相册）、关联品牌、日期、备注
- **搜索**：按名称、国家、标签、故事全文筛选
- **云端同步**：同一份 Supabase 数据；换手机打开同一网址即可
- **备份（可选）**：导出 / 导入 JSON
- **PWA**：Safari「添加到主屏幕」

内置示例品牌：**SOS · Sportswear of Sweden**（仅在 brands 表为空时自动写入）。

## 部署前：配置 Supabase（必做）

1. 打开 [Supabase Dashboard](https://supabase.com/dashboard) → 你的项目 `wwgxktdesiyvcweizyya`
2. 左侧 **SQL Editor** → New query → 粘贴并运行仓库根目录的 **`supabase-schema.sql`**（整份）
3. 确认 **Storage** 里有公开桶 **`finds`**  
   - 若 SQL 已成功创建桶，可跳过  
   - 否则：Storage → New bucket → 名称 `finds` → Public bucket 打开 → Create  
   - 再在 SQL Editor 把 schema 文件里 storage policies 那几段单独跑一遍（或整份重跑，幂等）
4. 打开站点：https://wiffy1988.github.io/brand-finder/  
   应能看到 SOS 示例。若顶部黄条提示表不存在，说明 SQL 还没跑成功。

### 安全说明（个人单用户）

anon key 写在前端 `config.js`（公开设计）。schema 里的 RLS 策略允许 **anon 读写全部表与 finds 桶**。任何人拿到 URL + anon key 都能改你的库。仅供自己使用；不要公开分享密钥。日后多用户需改成 `auth.uid()` 策略。

## 文件

```
index.html  styles.css  app.js  config.js  sw.js
manifest.webmanifest  icons/  supabase-schema.sql
```

发版时 bump `sw.js` 里的 `VERSION`。

## 本地预览

```bash
cd brand-finder && python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/
```

`app.js` 是 ES module，请用本地 HTTP 服务打开（不要用 `file://`）。

## 使用

1. iPhone Safari 打开站点 → 分享 → 添加到主屏幕
2. 「品牌」添加/编辑；「淘货」挂照片
3. 「我的」可导出 JSON 备份（可选）
