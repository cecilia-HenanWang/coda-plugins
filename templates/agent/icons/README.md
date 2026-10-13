# 回声图标

为这个模板画的单色图标（一个点和三道声波），随本仓库以 MIT 许可。清单里 `template: true`：只用黑色，客户端随文字颜色着色。

图标的规矩（Coda 读清单时核对）：插件目录里的 PDF，不超过 32 KiB；可另给深色外观用的 `dark`。画布照 Coda 自带图标定为 256 px：
iOS 按 96 pt 光栅化 PDF 时只缩不放，页面太小会画成一个点。SVG 是可审阅的源文件，PDF 由 CairoSVG 转换（开发工具，不是运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['echo']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```
