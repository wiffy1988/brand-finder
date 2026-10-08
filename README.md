# 尾货寻牌 (brand-finder)

Single-user, Chinese-UI PWA. Photos of one garment (logo / care label / details) are compressed in the
browser (longest edge 1280px, JPEG 0.82) and sent straight from the phone to the Google Gemini API
(`v1beta/models/{model}:generateContent`, `tools: [{googleSearch: {}}]`). No backend. The API key lives
only in the phone's localStorage; history (thumbnails, compressed photos, results) lives in IndexedDB.

Static files only: index.html, styles.css, app.js, sw.js, manifest.webmanifest, icons/.
Deploy the folder as-is to any static HTTPS host. Bump `VERSION` in sw.js when shipping changes.

Model plan (configurable in 设置): preferred model with search → alternate 2.5 model with search →
fallback model without search (results flagged 未联网, no listings).
Listing links are only shown when the listing's site matches a grounding source returned by Google
Search; otherwise the app shows a Google search link instead of any model-provided URL.
