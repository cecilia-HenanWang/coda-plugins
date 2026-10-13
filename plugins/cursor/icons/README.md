# Cursor 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `cursor.svg`：取自 [Cursor 品牌页](https://cursor.com/brand) 的官方[素材包](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip)，
  对应 `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg`（2D 立方体标志）。只把填色 `#26251e` 换成黑色、去掉 Illustrator 的注释与样式表，
  画布改成以标志为中心的正方形并定为 256 px（iOS 按 96 pt 光栅化 PDF 时只缩不放，页面太小会画成一个点），保留路径几何。
  单色，清单里 `template: true`，随文字颜色着色。用于 Cursor。

提取日期：2026-10-13。SVG 是可审阅的源文件，PDF 是由 CairoSVG 转换的等比矢量资源，清单的 `icon` 指向 PDF。重新生成 PDF（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['cursor']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```
